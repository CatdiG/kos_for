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

async function testToday1d() {
  console.log('=== Fetching Today (1d) Foreign Net Buy Ranking ===');
  const data = await fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL');

  if (!data || !data.list) {
    console.log('No data returned');
    return;
  }

  console.log(`Total 1d Items Returned: ${data.list.length}`);
  console.log('\n--- Top 5 Today (1d) Foreign Net Buy Stocks ---');
  data.list.slice(0, 5).forEach((item) => {
    console.log(`Rank ${item.rank} [${item.name} (${item.symbol})]: NetBuyAmt = ${item.netBuyAmtEok}억원 (${item.netBuyAmt}백만원), Qty = ${item.netBuyQty.toLocaleString()}주`);
  });
}

testToday1d().catch(console.error);
