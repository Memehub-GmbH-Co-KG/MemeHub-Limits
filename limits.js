const { Subscriber, Worker, Client } = require('redis-request-broker');
const { createHandyClient } = require('handy-redis');
const { Telegraf } = require('telegraf');
const cron = require('cron');
const lua = require('./lua');

const { log } = require('./log');

module.exports.build = async function (config) {
    const telegraf = new Telegraf(await requestBotToken(config.rrb.queueGetBotToken));
    const redis = createHandyClient(config.redis);
    const scripts = lua.loadAll(redis);

    // Start rrb stuff
    const workerMayPost = new Worker(config.rrb.queueMayPost, mayPost);
    const workerMayVote = new Worker(config.rrb.queueMayVote, mayVote);
    const workerGetQuota = new Worker(config.rrb.queueGetQuota, getQuota);
    const workerIssueTokens = new Worker(config.rrb.queueIssueTokens, issueTokens);
    const subscriberVote = new Subscriber(config.rrb.channelVote, onVote);
    const subscriberRetractVote = new Subscriber(config.rrb.channelRetractVote, onRetractVote);
    const subscriberPost = new Subscriber(config.rrb.channelPost, onPost);
    await workerMayPost.listen();
    await workerMayVote.listen();
    await workerGetQuota.listen();
    await workerIssueTokens.listen();
    await subscriberVote.listen();
    await subscriberRetractVote.listen();
    await subscriberPost.listen();

    // Start cron job
    const cronTime = cron.time(config.limits.post.time.cron);

    /**
     * Determines weather a user is allowed to post right now.
     * 
     * This depends on two factors: The amount of posts he has issued since the
     * last reset (limits.time.cron in the config) and the amount of reward
     * tokens he has.
     * @param {object} data An object with the property user_id.
     */
    async function mayPost(data) {
        // 1st: Check free posts
        if ((await getFreePosts(data.user_id))  > 0)
            return true;

        // 2nd: Check meme tokens
        return (await getTokens(data.user_id)) > 0;
    }

    /**
     * Determines weather a user is allowed to vote on a meme right now.
     * 
     * This depends on the amount of votes he has issued on that meme recently.
     * @param {object} data An object with the properties:
     *   user_id: The id of the user
     *   meme_id: The id of the meme on which the user wants to vote
     */
    async function mayVote(data) {
        const votesOnMeme = await redis.get(`${config.keys.votes}:${data.user_id}:${data.meme_id}`);
        return (parseInt(votesOnMeme) || 0) <= config.limits.vote.votes;
    }

    /**
     * Returns the current amount of meme tokens and the remaining free posts of a user
     * @param {object} data An object containing the property user_id.
     */
    async function getQuota(data) {
        const freePosts = await getFreePosts(data.user_id);
        const memeTokens = await getTokens(data.user_id);

        return {
            tokens: memeTokens,
            freePosts: freePosts
        }
    }

    /**
     * When a vote happens, we check weather the poster receives a reward post.
     * This is the case when the vote type is applicable and the new vote count
     * is exactly the limit specified. Self votes are ignored.
     */
    async function onVote(data) {
        handleVote(data.user_id, data.meme_id);

        // If this vote has been issued by the poster itself, ignore it.
        // This is not the same as checking data.self_vote
        if (data.poster_id === data.user_id)
            return;

        // We don't count self votes here
        if (data.self_vote)
            data.new_count--;

        // We only need to act if the new vote count is exactly the limit
        if (data.new_count !== config.limits.post.tokens.threshold)
            return;

        // Ignore any vote that is not applicable
        if (!config.limits.post.tokens.applicableVotes.includes(data.vote_type))
            return;

        // At this point we know that we have to give the user a reward
        await increaseTokens(data.poster_id, config.limits.post.tokens.gain, true);
    }

    /**
     * When a vote gets retracted we check weather we have to remove a reward post.
     * This is the case when the vote type is applicable and the new vote count
     * is one less than the limit specified. Self votes are ignored.
     * @param {*} data 
     */
    async function onRetractVote(data) {
        handleVote(data.user_id, data.meme_id);

        // If this vote has been issued by the poster itself, ignore it.
        // This is not the same as checking data.self_vote
        if (data.poster_id === data.user_id)
            return;

        // We don't count self votes here
        if (data.self_vote)
            data.new_count--;

        // We only need to act if the new vote count is one below the limit
        if (data.new_count !== config.limits.post.tokens.threshold - 1)
            return;

        // Ignore any vote that is not applicable
        if (!config.limits.post.tokens.applicableVotes.includes(data.vote_type))
            return;

        // At this point we know that we have to reduce the quota
        await decreaseTokens(data.poster_id, config.limits.post.tokens.gain, true);
    }

    /**
     * When a user makes a post we need to update the state.
     * 
     * For once we will count the posts a user does. Then, if the user has posted 
     * more that he may for free, we decrease the amount of reward tokens he has.
     * 
     * Informs the user about the new state afterwards.
     * @param {*} data 
     */
    async function onPost(data) {
        // Send the handlePost script to redis
        const [postsInTimeframe, tokens] = await scripts.handlePost(
            2, `${config.keys.posts}:${data.poster_id}`, `${config.keys.tokens}:${data.poster_id}`,
            cronTime.sendAt().unix(), config.limits.post.time.quota, config.limits.post.tokens.cost);

        const freePosts = config.limits.post.time.quota - postsInTimeframe;
        const tokensParsed = parseInt(tokens) || 0;

        // Inform the user about the new state
        const text = `You have ${quotaToStrnig(freePosts, 'free post')} and ${quotaToStrnig(tokensParsed, 'meme token')} left.`;
        await telegraf.telegram.sendMessage(data.poster_id, text);
    }

    /**
     * Keeps track on user voting in order to limit spamming.
     * @param {string} user_id The user that voted / retracted a vote.
     * @param {string} meme_id The meme that has been voted on.
     */
    async function handleVote(user_id, meme_id) {
        await scripts.handleVote(1, `${config.keys.votes}:${user_id}:${meme_id}`,
            config.limits.vote.votes, config.limits.vote.cooldown, config.limits.vote.ban);
    }

    /**
     * Increased the users reward quota by one and notifies the user about that.
     * @param {*} user_id 
     */
    async function increaseTokens(user_id, amount = 1, notify = false) {
        log('info', `increasing reward quota for user ${user_id} by ${amount}`);
        const newAmount = await redis.incrby(`${config.keys.tokens}:${user_id}`, amount);

        if (!notify)
            return newAmount;

        if (amount === 1)
            await telegraf.telegram.sendMessage(user_id, 'You got a reward token!');
        else
            await telegraf.telegram.sendMessage(user_id, `You got ${amount} reward tokens!`);
        return newAmount;
    }

    /**
     * Returns the current amount of meme tokens a user has
     * @param {stirng} user_id The user in question
     */
    async function getTokens(user_id) {
        const tokens = await redis.get(`${config.keys.tokens}:${user_id}`);
        return parseInt(tokens) || 0;
    }

    async function getFreePosts(user_id) {
        const postsInTimeframe = await redis.get(`${config.keys.posts}:${user_id}`);
        const freePosts = config.limits.post.time.quota - (parseInt(postsInTimeframe) || 0);
        return freePosts;
    }

    /**
     * Alters the amount of tokens a user has
     * @param {object} data An object with the following properties:
     *   user_id: The id uf the user
     *   amount: The amount of tokens to issue (may be negative or 0)
     * @returns The new amount of tokens the user has
     */
    async function issueTokens(data) {
        const { user_id, amount } = data;
        if (amount === 0) return await getTokens(user_id);
        if (amount < 0) return await decreaseTokens(user_id, -amount, true);
        return await increaseTokens(user_id, amount, true);
    }


    /**
     * Reduces the users reward quota by one and notifies the user about that.
     * @param {*} user_id 
     */
    async function decreaseTokens(user_id, amount = 1, notify = false) {
        log('info', `decreasing reward quota for user ${user_id} by ${amount}`);
        const newAmount = await redis.decrby(`${config.keys.tokens}:${user_id}`, amount);

        if (notify)
            await telegraf.telegram.sendMessage(user_id, `Your meme tokens have been decreased by ${amount}`);

        return newAmount;
    }

    function quotaToStrnig(amount, type) {
        if (amount < 1)
            return `no ${type}s`;

        if (amount === 1)
            return `one ${type}`;

        return `${amount} ${type}s`;
    }

    async function requestBotToken(queue) {
        const client = new Client(queue);
        try {
            await client.connect();
            return await client.request();
        }
        catch (error) {
            throw new Error(`Failed to get bot token: ${error.message}`);
        }
        finally {
            await client.disconnect();
        }
    }

    return {
        stop: async function () {
            await workerMayPost.stop();
            await workerMayVote.stop();
            await workerGetQuota.stop();
            await workerIssueTokens.stop();
            await subscriberVote.stop();
            await subscriberRetractVote.stop();
            await subscriberPost.stop();
            await redis.quit();
        }
    };
}