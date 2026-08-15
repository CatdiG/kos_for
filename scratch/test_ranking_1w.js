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

async function test1w() {
  console.log('=== Fetching 1-Week (1w) Foreign Net Buy Ranking ===');
  const data = await fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1w&market=ALL');
  if (!data || !data.list) {
    console.log('No data returned');
    return;
  }
  console.log(`Total 1w Items Returned: ${data.list.length}`);
  console.log('\n--- Top 10 1-Week (1w) Foreign Net Buy Stocks ---');
  data.list.slice(0, 10).forEach((item) => {
    console.log(`Rank ${item.rank} [${item.name} (${item.symbol})]: 5-Day Cumulative Net Buy = ${item.netBuyAmtEok}억원 (${item.netBuyAmt}백만원), Qty = ${item.netBuyQty.toLocaleString()}주`);
  });
}

test1w().catch(console.error);
