const cfg = {
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
};

async function testUpstashOfficial() {
  if (!cfg.url || !cfg.token) {
    console.log('No Redis Env');
    return;
  }
  console.log('Testing Official Upstash REST Command Array format...');
  const key = 'test_token_official';
  const tokenCache = {
    access_token: 'valid_access_token_abc123',
    expires_at: Date.now() + 86400000,
    app_key_hash: 'PSvmMT_real',
  };

  // 1. SET via POST command array
  const setRes = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(tokenCache), 'EX', 86400]),
  });
  console.log('SET Status:', setRes.status, await setRes.json());

  // 2. GET via POST command array
  const getRes = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  const getJson = await getRes.json();
  console.log('GET Result:', getJson);
  const parsed = JSON.parse(getJson.result);
  console.log('Parsed Token:', parsed.access_token);
}

testUpstashOfficial().catch(console.error);
