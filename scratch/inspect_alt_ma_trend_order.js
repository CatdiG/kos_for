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
  const symbol = '459550'; // 알트 (Alt)
  console.log(`Inspecting Alt (${symbol}) trend order and MA values...`);
  const res = await fetchLocalTrend(symbol, '20d');
  const trend = res.trend || [];

  console.log(`Returned trend item count: ${trend.length}`);
  console.log(`Item 0 (First in array): Date=${trend[0]?.formattedDate} (${trend[0]?.date}), Close=${trend[0]?.closePrice}`);
  console.log(`Item N (Last in array): Date=${trend[trend.length - 1]?.formattedDate} (${trend[trend.length - 1]?.date}), Close=${trend[trend.length - 1]?.closePrice}`);

  console.log(`\nFull list of items in array order (Index 0 to ${trend.length - 1}):`);
  trend.forEach((item, idx) => {
    console.log(`Index ${idx}: Date=${item.formattedDate} (${item.date}) | Open=${item.openPrice} | High=${item.highPrice} | Low=${item.lowPrice} | Close=${item.closePrice}`);
  });
}

main().catch(console.error);
