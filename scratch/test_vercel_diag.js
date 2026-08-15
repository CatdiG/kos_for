const http = require('https');

async function testVercel() {
  const url = 'https://kos-for.vercel.app/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL';
  const start = Date.now();
  
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let ttfb = Date.now() - start;
      let data = '';
      res.on('data', (chunk) => {
        if (!data) {
          // First chunk received = TTFB
        }
        data += chunk;
      });
      res.on('end', () => {
        const totalTime = Date.now() - start;
        console.log('HTTP Status:', res.statusCode);
        console.log('x-vercel-id:', res.headers['x-vercel-id']);
        console.log('x-vercel-cache:', res.headers['x-vercel-cache']);
        console.log('TTFB:', ttfb, 'ms');
        console.log('Total Time:', totalTime, 'ms');
        try {
          const json = JSON.parse(data);
          console.log('Perf Payload:', json.perf);
          console.log('List Length:', json.list?.length);
        } catch (e) {
          console.log('Response body prefix:', data.slice(0, 200));
        }
        resolve({ ttfb, totalTime, vercelId: res.headers['x-vercel-id'] });
      });
    });
    req.on('error', reject);
  });
}

testVercel().catch(console.error);
