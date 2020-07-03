# Lua scripts

The scripts in this directory are designed to run in the redis db. Get familiar with the concept of lua scripts in redis in the docs for [EVAL](https://redis.io/commands/eval) and [EVALSHA](https://redis.io/commands/evalsha). Descriptions of the scripts should be collected here in order to reduce the amount of data that has to be sent to the db.

The `index.js` can be used to handle the overhead of using the sha1 optimization.

## handleVote

Increases the counter of the provided key (votes of a user on a meme) and sets a new expire time. The new time depends on the new value of the counter.

Returns the new count.

### Keys

 1. The key that counts votes by a user on a given meme

### Arguments:

 1. The amount of votes a user is allowed to issue during the expire time
 2. The new expire time for when the limit has not been reached yet in ms
 3. The new expire time for when the limit has been reached or surpassed in ms

## handlePost

Increases the post counter for a user and reduces the amount of meme tokens, if he has no free posts left.

Returns the new amount of the post counter and the new amount of meme tokens.

### Keys

 1. The key that counts the amount of posts a user did in  a given timeframe
 2. The key that counts the amount of meme tokens a user has

### Arguments

 1. The date at which the post counter shoud expire (unix timestamp in seconds)
 2. The amount of posts a user may make before having to use meme tokens for that
 3. The amount of meme tokens to use, when a user has to pay for a post