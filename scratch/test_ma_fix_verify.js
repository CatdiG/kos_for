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
  const symbol = '005930'; // 삼성전자
  console.log(`Verifying MA calculation for Samsung Electronics (${symbol})...`);
  const res = await fetchLocalTrend(symbol, '60d');
  const trend = res.trend || [];
  console.log(`Total trend items fetched from API: ${trend.length}`);

  // Calculate MA on full trend
  const fullTrendWithMA = trend.map((item, idx, arr) => {
    // 5-day MA
    const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
    const ma5 = slice5.length === 5 
      ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / 5) 
      : (idx > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : item.closePrice);

    // 20-day MA
    const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
    const ma20 = slice20.length === 20
      ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / 20)
      : (idx > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : item.closePrice);

    // 60-day MA
    const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
    const ma60 = slice60.length === 60
      ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / 60)
      : (idx > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : item.closePrice);

    return {
      date: item.formattedDate,
      closePrice: item.closePrice,
      ma5,
      ma20,
      ma60,
    };
  });

  const sliced20 = fullTrendWithMA.slice(-20);
  console.log(`\nLatest 5 days displayed in chart (20d view):`);
  sliced20.slice(-5).forEach(d => {
    console.log(`Date: ${d.date} | Close: ${d.closePrice.toLocaleString()}원 | MA5: ${d.ma5.toLocaleString()}원 | MA20: ${d.ma20.toLocaleString()}원 | MA60: ${d.ma60.toLocaleString()}원`);
  });
}

main().catch(console.error);
