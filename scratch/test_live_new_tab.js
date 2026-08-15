const http = require('https');

async function testLiveNewTab() {
  const urls = [
    'https://kos-for.vercel.app/',
    'https://kos-for.vercel.app/api/stock/surging?mode=fluctuation&market=ALL',
    'https://kos-for.vercel.app/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL',
  ];

  for (const url of urls) {
    console.log('Testing URL:', url);
    const start = Date.now();
    try {
      const res = await fetch(url);
      console.log('Status:', res.status, 'Time:', Date.now() - start, 'ms');
      if (url.includes('/api/')) {
        const text = await res.text();
        console.log('Body snippet:', text.slice(0, 200));
      }
    } catch (e) {
      console.error('Error fetching', url, e);
    }
  }
}

testLiveNewTab().catch(console.error);
