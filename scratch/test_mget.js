const cfg = {
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
};

async function test() {
  console.log('Testing MGET with Upstash REST API...');
  const keys = ['kv_credit_005930', 'kv_credit_000660', 'kv_credit_035420'];
  const keysPath = keys.map((k) => encodeURIComponent(k)).join('/');
  const url = `${cfg.url}/mget/${keysPath}`;
  console.log('URL:', url);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  console.log('Status:', res.status);
  const json = await res.json();
  console.log('Result:', json);
}

if (cfg.url) test().catch(console.error);
else console.log('No KV/Redis URL in env');
