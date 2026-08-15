const http = require('https');

async function testLiveFast() {
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
      const text = await res.text();
      console.log('Body snippet:', text.slice(0, 150));
    } catch (e) {
      console.error('Error fetching', url, e);
    }
  }
}

testLiveFast().catch(console.error);
