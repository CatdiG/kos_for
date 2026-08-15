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

async function testRankingPeriods() {
  console.log('=== Testing 1-Week (1w) and 1-Month (1m) Ranking API Calls ===');

  const [todayData, weekData, monthData] = await Promise.all([
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=today&market=ALL'),
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1w&market=ALL'),
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1m&market=ALL'),
  ]);

  console.log(`\n--- Today (당일) Foreign Net Buy Top 5 ---`);
  if (todayData && todayData.list) {
    todayData.list.slice(0, 5).forEach((item) => {
      console.log(`Rank ${item.rank} [${item.name} ${item.symbol}]: NetBuyAmt = ${item.netBuyAmtEok}억원 (${item.netBuyAmt}백만원), Qty = ${item.netBuyQty.toLocaleString()}주`);
    });
  }

  console.log(`\n--- 1-Week (1주일 5거래일) Foreign Net Buy Top 5 ---`);
  if (weekData && weekData.list) {
    weekData.list.slice(0, 5).forEach((item) => {
      console.log(`Rank ${item.rank} [${item.name} ${item.symbol}]: NetBuyAmt = ${item.netBuyAmtEok}억원 (${item.netBuyAmt}백만원), Qty = ${item.netBuyQty.toLocaleString()}주`);
    });
  }

  console.log(`\n--- 1-Month (1개월 20거래일) Foreign Net Buy Top 5 ---`);
  if (monthData && monthData.list) {
    monthData.list.slice(0, 5).forEach((item) => {
      console.log(`Rank ${item.rank} [${item.name} ${item.symbol}]: NetBuyAmt = ${item.netBuyAmtEok}억원 (${item.netBuyAmt}백만원), Qty = ${item.netBuyQty.toLocaleString()}주`);
    });
  }
}

testRankingPeriods().catch(console.error);
