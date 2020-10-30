const { Defaults, Subscriber, Client } = require('redis-request-broker');

const log = require('./log');
const { build } = require('./limits');

let limits;
let isShuttingDown = false;
let restartSubscriber;

async function start() {

    console.log('Starting up...');

    // Set rrb defaults
    Defaults.setDefaults({
        redis: {
            prefix: 'mh:',
            host: "mhredis"
        }
    });

    // Get config and lua on startup
    let config;
    try {
        config = await getConfig();
    } catch (e) {
        console.error('Cannot load config. Exiting.');
        console.error(e);
        process.exit(1);
    }

    // Trigger restart on config change
    restartSubscriber = new Subscriber(config.rrb.channels.config.changed, onConfigChange);
    await restartSubscriber.listen();

    await log.start(config);

    // Init limits
    limits = await build(config);
    await log.log('notice', 'Startup complete.');

}

async function stop() {
    if (isShuttingDown)
        return;
    isShuttingDown = true;

    await log.log('notice', 'Shutting down...');
    restartSubscriber && await restartSubscriber.stop().catch(console.error);
    await limits.stop().catch(console.error);
    await log.stop().catch(console.error);
    console.log('Shutdown complete.');
    isShuttingDown = false;
}


async function restart() {
    await stop();
    await start();
}

async function onConfigChange(keys) {
    if (!Array.isArray(keys))
        restart();

    if (keys.some(k => k.startsWith('redis') || k.startsWith('rrb') || k.startsWith('limits') || k.startsWith('telegram')))
        restart();
}


async function getConfig() {
    const client = new Client('config:get', { timeout: 10000 });
    await client.connect();
    const [redis, rrb, limits, telegram] = await client.request(['redis', 'rrb', 'limits', 'telegram']);
    await client.disconnect();
    return { redis, rrb, limits, telegram };
}

start().catch(error => console.log(`Failed to start:\n`, error));

process.on('SIGINT', stop);
process.on('SIGQUIT', stop);
process.on('SIGTERM', stop);