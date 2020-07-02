# MemeHub-Limits
Handles different types of user action limits for the MemeHub. For now this includes posting and voting. The state is stored in a redis db, but you should not run multiple instances of MemeHub-Limits at the same time for now, as every instance rewards users with tokens for votes. The telegram bot token is needed and requested from the MemeHub Bot. Therfore MemeHub Limits will fail to start if there is no running MemeHub Bot.

# Setup

 - You will need a redis running and a working instance of the MemeHub Bot.
 - copy `config.template.yaml` to `config.yaml`
 - configure, in paticular `botToken` and `rb.redis` should be set
 - run `npm i`
 
## Starting
 
For now, run using `npm run start` or `node index.js`.

## State

The following data is stored in the redis db:

 - Posts since the last reset of timebased tokens (`limits:state:posts:<user_id>`). A simple integer that is increased with every post.
   The key is set to expire when timebased tokens expire. Therfore we don't store actual timebased tokens. We just store how
   often a user has posted.
 - Reward tokens of a user (`limits:state:token:<user_id>`). A integer that stores the amount of reward tokens a user has.
   If the user posts and has no time based tokens left, the value gets reduced by one. The key is not set to expire.
 - Issued likes on a meme by a user (`limits:state:votes:<user_id>:<post_id>`). This key expires after the cooldown set in the config.
   The expire is reset everytime the user issues a vote. And if the count is larger than what is allow, the expire is the to the ban time.

## Limits
### Posting

Weather a user may post is depending on two factors.
  - Free posts in a given timeframe
  - Using tokens

If the user has posted more than he may for free and has no tokens left, he may not post.
A user may gain tokens for memes that get enough votes.

### Voting

How often a user may vote is limited per meme. This limit prevents users from spamming the vote button which may cause other users to get
spammed by the bot. The amount of votes a user issued is stored in the redis db. The information expires after some time. If the user voted
more than allowed, he will not be allowed to vote until a ban time has expired. Voting and retracting a vote is the same here.