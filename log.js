const { Publisher } = require('redis-request-broker');
const i = require('./instance');
let client;

async function start(config) {
    const c = new Publisher(config.rrb.channelLogging);
    await c.connect();
    client = c;
}

async function stop() {
    const c = client;
    client = undefined;
    await c.disconnect();
}

async function log(level, title, data, component = i.component, instance = i.instance) {
    if (!client) {
        console.log('Cannot send log, as not started jet.');
        return;
    }

    try {
        const r = await client.publish({ level, title, data, component, instance });
        if (r < 1) console.warn('log not received by logger.');
    }
    catch (error) {
        console.log('Failed to log message');
    }
}

module.exports.log = log;
module.exports.start = start;
module.exports.stop = stop;