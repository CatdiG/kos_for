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

async function check1142Status() {
  console.log(`=== Querying KIS Ranking API at ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} ===`);
  const data = await fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL');

  if (!data || !data.list) {
    console.log('Failed to fetch data');
    return;
  }

  console.log(`isMock: ${data.isMock}, items count: ${data.list.length}`);
  
  const nonZeroCount = data.list.filter(item => (item.netBuyAmt || 0) !== 0 || (item.netBuyQty || 0) !== 0).length;
  console.log(`Non-zero Net Buy Items Count: ${nonZeroCount} / ${data.list.length}`);

  console.log('\n--- Top 5 Foreigner Ranking Raw Output ---');
  data.list.slice(0, 5).forEach((item, idx) => {
    console.log(`[${idx + 1}] Symbol: ${item.symbol}, Name: ${item.name}`);
    console.log(`    Price: ${item.currentPrice} 원, Volume: ${item.volume}`);
    console.log(`    netBuyQty: ${item.netBuyQty}, netBuyAmt: ${item.netBuyAmt} 백만원 (${item.netBuyAmtEok} 억원)`);
  });
}

check1142Status().catch(console.error);
