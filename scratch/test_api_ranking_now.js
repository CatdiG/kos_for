const http = require('http');

function fetchJson(pathStr) {
  return new Promise((resolve) => {
    http.get(`http://localhost:3000${pathStr}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function runCheckNow() {
  console.log(`=== Querying Local API Route (/api/stock/ranking) at ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} ===`);
  const data = await fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL');

  if (!data || !data.list) {
    console.log('Failed to fetch ranking data.');
    return;
  }

  console.log(`isMock: ${data.isMock}, items count: ${data.list.length}`);
  console.log('\n--- Top 5 Foreigner Buy Items Currently Returned by System ---');
  data.list.slice(0, 5).forEach((item, idx) => {
    console.log(`Item ${idx + 1}: [${item.symbol}] ${item.name}`);
    console.log(`  Price: ${item.currentPrice} 원`);
    console.log(`  netBuyQty (순매수 수량): ${item.netBuyQty} 주`);
    console.log(`  netBuyAmt (순매수 대금): ${item.netBuyAmt} 백만원 (${item.netBuyAmtEok} 억원)`);
  });
}

runCheckNow().catch(console.error);
