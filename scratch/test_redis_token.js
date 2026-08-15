const cfg = {
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
};

async function test() {
  console.log('Testing Token Save & Read in Upstash Redis...');
  const appKeyHash = 'test_hash';
  const tokenData = {
    access_token: 'test_access_token_12345',
    expires_at: Date.now() + 86400 * 1000,
    app_key_hash: appKeyHash,
  };

  // Save
  const jsonStr = JSON.stringify(tokenData);
  const saveUrl = `${cfg.url}/set/kis_token_${appKeyHash}/${encodeURIComponent(jsonStr)}/EX/3600`;
  const saveRes = await fetch(saveUrl, { headers: { Authorization: `Bearer ${cfg.token}` } });
  console.log('Save Status:', saveRes.status, await saveRes.json());

  // Get
  const getUrl = `${cfg.url}/get/kis_token_${appKeyHash}`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${cfg.token}` } });
  const getJson = await getRes.json();
  console.log('Get Status:', getRes.status, 'Result:', getJson);

  let rawVal = getJson.result;
  let parsed = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
  console.log('Parsed token:', parsed?.access_token);
}

if (cfg.url) test().catch(console.error);
else console.log('No Redis URL in env');
