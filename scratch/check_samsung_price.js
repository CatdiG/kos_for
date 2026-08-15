const http = require('http');

function fetchLocalTrend(symbol) {
  return new Promise((resolve) => {
    const url = `http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d&t=${Date.now()}`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({ error: e.message }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

async function main() {
  const symbol = '005930'; // 삼성전자
  console.log(`Checking Samsung Electronics (${symbol}) from local server API...`);
  const res = await fetchLocalTrend(symbol);
  if (res.stockInfo) {
    console.log(`Stock Info: Name=${res.stockInfo.name}, Market=${res.stockInfo.market}, CurrentPrice=${res.stockInfo.currentPrice}`);
  }
  if (res.trend && res.trend.length > 0) {
    console.log(`Trend count: ${res.trend.length}`);
    console.log(`Latest 5 items for Samsung Electronics:`);
    res.trend.slice(-5).forEach(item => {
      console.log(`Date: ${item.formattedDate} (${item.date}) | Open: ${item.openPrice} | High: ${item.highPrice} | Low: ${item.lowPrice} | Close: ${item.closePrice}`);
    });
  } else {
    console.log('Response:', res);
  }
}

main().catch(console.error);
