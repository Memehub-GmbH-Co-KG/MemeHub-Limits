const { Defaults } = require('redis-request-broker');
const yaml = require('js-yaml');
const fs = require('fs');

const log = require('./log');
const { build } = require('./limits');

let limits;
let isShuttingDown = false;

async function start() {

    console.log('Starting up...');

    // Read config and lua on startup
    let config;
    try {
        config = yaml.safeLoad(fs.readFileSync('config.yaml', 'utf8'));
    } catch (e) {
        console.error('Cannot load config or lua file. Exiting.');
        console.error(e);
        process.exit(1);
    }


    // Set rrb defaults
    Defaults.setDefaults({
        redis: config.redis
    });

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
    await limits.stop();
    await log.stop();
    console.log('Shutdown complete.');
    isShuttingDown = false;
}

start().catch(error => console.log(`Failed to start:\n`, error));

process.on('SIGINT', stop);
process.on('SIGQUIT', stop);
process.on('SIGTERM', stop);