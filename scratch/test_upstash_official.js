const { Redis } = require('@upstash/redis');

async function testOfficial() {
  console.log('Testing @upstash/redis official SDK...');
  try {
    const redis = Redis.fromEnv();
    await redis.set('test_key_official', 'HELLO_UPSTASH_OK', { ex: 60 });
    const val = await redis.get('test_key_official');
    console.log('Official Upstash GET Result:', val);
  } catch (e) {
    console.error('Official Upstash Failed:', e.message);
  }
}

testOfficial();
