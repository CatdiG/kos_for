const fs = require('fs');

async function test401() {
  const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
  console.log('REDIS_URL from env:', redisUrl ? 'Exists' : 'Missing');
}

test401().catch(console.error);
