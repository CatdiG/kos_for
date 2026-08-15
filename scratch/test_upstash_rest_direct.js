const redisUrl = process.env.REDIS_URL;
console.log('REDIS_URL:', redisUrl);

function parseRedisUrl(redisUrl) {
  if (!redisUrl || typeof redisUrl !== 'string') return null;
  try {
    const cleanUrl = redisUrl.trim().replace(/^rediss?:\/\//i, '');
    const [authPart, hostPart] = cleanUrl.split('@');
    if (!authPart || !hostPart) return null;
    const token = authPart.includes(':') ? authPart.split(':')[1] : authPart;
    const host = hostPart.split(':')[0];
    if (token && host) {
      return {
        url: `https://${host}`,
        token,
      };
    }
  } catch (e) {}
  return null;
}

async function testDirect() {
  const cfg = parseRedisUrl(redisUrl);
  console.log('Parsed Config:', cfg);
  if (!cfg) return;

  const res = await fetch(cfg.url + '/get/test_key', {
    headers: { Authorization: `Bearer ${cfg.token}` }
  });
  console.log('Status:', res.status, await res.text());
}

if (redisUrl) testDirect().catch(console.error);
