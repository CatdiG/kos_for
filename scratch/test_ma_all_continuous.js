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

async function verifyAllMaContinuous() {
  console.log('=== Verifying SK Hynix (000660) Continuous MA5, MA20, MA60 Data ===');
  const data = await fetchJson('/api/stock/investor-trend?symbol=000660&period=20d');

  if (!data || !data.trend) {
    console.log('Failed to fetch trend data');
    return;
  }

  console.log(`Stock: [${data.stockInfo?.symbol}] ${data.stockInfo?.name}, Total trend items: ${data.trend.length}`);
  console.log('\n--- 20D Chart Items MA Values ---');

  // Simulate frontend displayTrend calculation
  const trend = data.trend;
  const fullTrendWithMA = trend.map((item, idx, arr) => {
    const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
    const ma5 = Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / (slice5.length || 1));

    const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
    const ma20 = Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / (slice20.length || 1));

    const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
    const ma60 = Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / (slice60.length || 1));

    return {
      formattedDate: item.formattedDate,
      closePrice: item.closePrice,
      ma5,
      ma20,
      ma60,
    };
  });

  const displayTrend = fullTrendWithMA.slice(-20);

  displayTrend.forEach((d, idx) => {
    console.log(`Item ${idx + 1} [${d.formattedDate}]: Close=${d.closePrice.toLocaleString()}원 | MA5=${d.ma5.toLocaleString()}원 | MA20=${d.ma20.toLocaleString()}원 | MA60=${d.ma60.toLocaleString()}원`);
  });
}

verifyAllMaContinuous().catch(console.error);
