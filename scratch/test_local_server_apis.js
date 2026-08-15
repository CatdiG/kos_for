async function testLocalEndpoints() {
  console.log('=== Testing Local Dev Server Endpoints ===');
  const urls = [
    'http://localhost:3000/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL',
    'http://localhost:3000/api/stock/ranking?type=organ&direction=buy&period=1d&market=ALL',
    'http://localhost:3000/api/stock/surging?mode=fluctuation&market=ALL',
    'http://localhost:3000/api/stock/surging?mode=comprehensive&market=ALL',
    'http://localhost:3000/api/stock/investor-trend?symbol=005930&period=20d',
    'http://localhost:3000/api/stock/quotes?symbols=005930,000660',
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      console.log(`URL: ${url}`);
      console.log(`Status: ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const text = await res.text();
        console.error(`Error Body:`, text);
      } else {
        const json = await res.json();
        console.log(`Success! Item count / keys:`, json.list?.length || Object.keys(json));
      }
    } catch (e) {
      console.error(`Fetch exception for ${url}:`, e.message);
    }
    console.log('---');
  }
}

testLocalEndpoints();
