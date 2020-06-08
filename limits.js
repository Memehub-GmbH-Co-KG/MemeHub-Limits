const { Subscriber, Worker } = require('redis-request-broker');
const { Telegraf } = require('telegraf');
const cron = require('cron');

const { log } = require('./log');

module.exports.build = async function (config) {
    const telegraf = new Telegraf(config.botToken);
    const quotas = {};

    // Start rrb stuff
    const workerMayPost = new Worker(config.rrb.queueMayPost, mayPost);
    const workerGetQuota = new Worker(config.rrb.queueGetQuota, getQuota);
    const subscriberVote = new Subscriber(config.rrb.channelVote, onVote);
    const subscriberRetractVote = new Subscriber(config.rrb.channelRetractVote, onRetractVote);
    const subscriberPost = new Subscriber(config.rrb.channelPost, onPost);
    await workerMayPost.listen();
    await workerGetQuota.listen();
    await subscriberVote.listen();
    await subscriberRetractVote.listen();
    await subscriberPost.listen();

    // Start cron job
    const job = cron.job(config.limits.time.cron, resetTimeQuotas, null, true);

    async function mayPost(data) {
        const quota = quotas[data.user_id];

        // If there is no data on that user, he is allowed to post
        if (!quota)
            return true;

        // Else he may post if one of the quotas is more than 0
        return quota.time > 0 || quota.reward > 0;
    }

    async function getQuota(data) {
        const quota = quotas[data.user_id];

        // If there is no data on that user, he has the default quota
        if (!quota)
            return { time: config.limits.time.quota, reward: 0 };

        return quota;
    }

    /**
     * When a vote happens, we check weather the poster receives a reward post.
     * This is the case when the vote type is applicable and the new vote count
     * is exactly the limit specified. Self votes are ignored.
     */
    async function onVote(data) {
        // If this vote has been issued by the poster itself, ignore it.
        // This is not the same as checking data.self_vote
        if (data.poster_id === data.user_id)
            return;

        // We don't count self votes here
        if (data.self_vote)
            data.new_count--;

        // We only need to act if the new vote count is exactly the limit
        if (data.new_count !== config.limits.vote.threshold)
            return;

        // Ignore any vote that is not applicable
        if (!config.limits.vote.applicableVotes.includes(data.vote_type))
            return;

        // At this point we know that we have to give the user a reward
        await increaseRewardQuota(data.poster_id);
    }

    /**
     * When a vote gets retracted we check weather we have to remove a reward post.
     * This is teh case when the vote type is applicable and the new vote count
     * is one less than the limit specified. Self votes are ignored.
     * @param {*} data 
     */
    async function onRetractVote(data) {
        // If this vote has been issued by the poster itself, ignore it.
        // This is not the same as checking data.self_vote
        if (data.poster_id === data.user_id)
            return;

        // We don't count self votes here
        if (data.self_vote)
            data.new_count--;

        // We only need to act if the new vote count is one below the limit
        if (data.new_count !== config.limits.vote.threshold - 1)
            return;

        // Ignore any vote that is not applicable
        if (!config.limits.vote.applicableVotes.includes(data.vote_type))
            return;

        // At this point we know that we have to reduce the quota by one
        await decreaseRewardQuota(data.poster_id);
    }

    /**
     * When a user makes a post we need to use a token for that.
     * Time based tokens are used first. Reward tokens are only used
     * if the user has no time based toklen left.
     * 
     * Informs the user about the new state afterwards.
     * @param {*} data 
     */
    async function onPost(data) {
        let quota = quotas[data.poster_id];

        if (!quota) {
            quota = { time: config.limits.time.quota - 1, reward: 0 };
            quotas[data.poster_id] = quota;
        }
        else if (quota.time > 0)
            quota.time--;
        else
            quota.reward--;

        // Inform the user about the new state
        const text = `You have ${quotaToStrnig(quota.time, 'daily')} and ${quotaToStrnig(quota.reward, 'reward')} left.`;
        await telegraf.telegram.sendMessage(data.poster_id, text);
    }

    /**
     * Increased the users reward quota by one and notifies the user about that.
     * @param {*} user_id 
     */
    async function increaseRewardQuota(user_id) {
        log('info', `increasing reward quota for user ${user_id}`);
        const quota = quotas[user_id];
        if (quota)
            quota.reward++;
        else
            quotas[user_id] = { time: config.limits.time.quota, reward: 1 };
        await telegraf.telegram.sendMessage(user_id, 'You got a reward token!');
    }


    /**
     * Reduces the users reward quota by one and notifies the user about that.
     * @param {*} user_id 
     */
    async function decreaseRewardQuota(user_id) {
        log('info', `decreasing reward quota for user ${user_id}`);
        const quota = quotas[user_id];
        if (quota)
            quota.reward--;
        else
            quotas[user_id] = { time: config.limits.time.quota, reward: -1 };
        await telegraf.telegram.sendMessage(user_id, 'One reward token has been taken away from you.');

    }

    /**
     * Resets all time based quotas. If a user has no reward tokens, no data 
     * will be stored for him.
     */
    async function resetTimeQuotas() {
        log('info', 'Resetting time quotas');
        for (const user of Object.keys(quotas)) {
            const oldQuota = quotas[user];
            if (oldQuota.reward === 0)
                delete quotas[user];
            else
                oldQuota.time = config.limits.time.quota;
        }
    }

    function quotaToStrnig(amount, type) {
        if (amount < 1)
            return `no ${type} tokens`;

        if (amount === 1)
            return `one ${type} token`;

        return `${amount} ${type} tokens`;
    }

    return {
        stop: async function () {
            await workerMayPost.stop();
            await workerGetQuota.stop();
            await subscriberVote.stop();
            await subscriberRetractVote.stop();
            await subscriberPost.stop();
            job.stop();
        }
    };
}