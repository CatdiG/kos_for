const http = require('https');

async function testTrend() {
  const url = 'https://kos-for.vercel.app/api/stock/investor-trend?symbol=005930&period=60d';
  console.log('Fetching:', url);
  const start = Date.now();
  const req = http.get(url, (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      console.log('Headers:', res.headers['x-vercel-id']);
      console.log('Elapsed:', Date.now() - start, 'ms');
      console.log('Body prefix:', data.slice(0, 300));
    });
  });
  req.on('error', console.error);
}

testTrend();
