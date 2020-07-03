local posts = redis.call("INCR", KEYS[1])
redis.call("EXPIREAT", KEYS[1], ARGV[1])
local tokens
if posts > tonumber(ARGV[2]) then
    tokens = redis.call("DECRBY", KEYS[2], ARGV[3])
else
    tokens = redis.call("GET", KEYS[2])
end
return {posts, tokens}