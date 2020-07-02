local count = redis.call("INCR", KEYS[1])
local time = ARGV[2]
if count > tonumber(ARGV[1]) then time = ARGV[3] end
redis.call("PEXPIRE", KEYS[1], time)
return count