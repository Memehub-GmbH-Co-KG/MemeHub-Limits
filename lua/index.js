const sha1 = require('sha1');
const fs = require('fs');

/**
 * Creates an object containing execute functions for all lua files present in this directory.
 * 
 * Eg. when there is a script called test.lua, calling
 * 
 * `await loadAll().test(1, 'mykey', 'myarg1', 'myarg2')`
 * 
 * will execute the script using the provided redis instance. It will try to use EVALSHA first
 * and fall back to EVAL.
 * 
 * @param {*} redis The handy redis client to use.
 */
module.exports.loadAll = function loadAll(redis) {
    _redis = redis;
    const scripts = fs.readdirSync('./lua')
        .filter(f => f.endsWith('.lua'))
        .map(f => f.replace('.lua', ''));

    console.log('Loading lua scripts:', scripts);

    return scripts.reduce((lua, file) => ({ ...lua, [file]: build(file, redis) }), {});
}


function build(name, redis) {

    // Load the lua file
    const script = fs.readFileSync(`./lua/${name}.lua`, 'utf8');

    // Calculate sha1
    const sha = sha1(script);

    // Return a function that executes the script against the redis
    return async function (...args) {
        let res;
        try {
            res = await redis.evalsha(sha, ...args);
        }
        catch (error) {
            if (error.code !== 'NOSCRIPT')
                throw error;

            res = await redis.eval(script, ...args);
        }

        return res;
    }
}