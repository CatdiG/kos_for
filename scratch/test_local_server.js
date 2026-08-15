const http = require('http');

function fetchLocalTrend(symbol) {
  return new Promise((resolve) => {
    const url = `http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d&t=${Date.now()}`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({ error: e.message, raw: body }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

async function main() {
  const symbol = '459550';
  console.log(`Querying http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d ...`);
  const res = await fetchLocalTrend(symbol);
  if (res.trend) {
    console.log(`Trend count: ${res.trend.length}`);
    console.log(`Latest 5 items:`);
    res.trend.slice(-5).forEach(item => {
      console.log(`Date: ${item.formattedDate} (${item.date}) | Open: ${item.openPrice} | High: ${item.highPrice} | Low: ${item.lowPrice} | Close: ${item.closePrice} | Vol: ${item.volume}`);
    });
  } else {
    console.log(`Response:`, res);
  }
}

main().catch(console.error);
