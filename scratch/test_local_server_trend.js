const http = require('http');

function fetchLocalTrend(symbol, period) {
  return new Promise((resolve) => {
    const url = `http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=${period}&t=${Date.now()}`;
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
  const symbols = ['459550', '005930', '000660'];
  for (const symbol of symbols) {
    console.log(`=== Testing Symbol: ${symbol} ===`);
    const data = await fetchLocalTrend(symbol, '60d');
    const trend = data.trend || [];
    console.log(`Returned trend items count: ${trend.length}`);
    if (trend.length > 0) {
      console.log(`First item: Date=${trend[0].formattedDate}, Close=${trend[0].closePrice}, MA5=${trend[0].ma5}, MA20=${trend[0].ma20}, MA60=${trend[0].ma60}`);
      const last = trend[trend.length - 1];
      console.log(`Last item: Date=${last.formattedDate}, Close=${last.closePrice}, MA5=${last.ma5}, MA20=${last.ma20}, MA60=${last.ma60}`);
    }
  }
}

main().catch(console.error);
