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

async function verifySkhynixOhlc() {
  console.log('=== Verifying SK Hynix (000660) Live OHLC Chart Data ===');
  const data = await fetchJson('/api/stock/investor-trend?symbol=000660&period=20d');

  if (!data || !data.trend) {
    console.log('Failed to fetch trend data.');
    return;
  }

  console.log(`Stock: [${data.stockInfo?.symbol}] ${data.stockInfo?.name}`);
  console.log(`Total Daily Trend Items Returned: ${data.trend.length}`);
  console.log('\n--- Recent 5 Days OHLC Candlestick Data ---');

  data.trend.slice(-5).forEach((item, idx) => {
    const isGain = (item.closePrice >= (item.openPrice || item.closePrice));
    const candleColor = isGain ? '🔴 상승 (Red)' : '🔵 하락 (Blue)';
    console.log(`Day ${idx + 1} [${item.formattedDate} (${item.date})]:`);
    console.log(`  시가 (Open) : ${item.openPrice?.toLocaleString() || 'N/A'} 원`);
    console.log(`  고가 (High) : ${item.highPrice?.toLocaleString() || 'N/A'} 원`);
    console.log(`  저가 (Low)  : ${item.lowPrice?.toLocaleString() || 'N/A'} 원`);
    console.log(`  종가 (Close): ${item.closePrice?.toLocaleString() || 'N/A'} 원`);
    console.log(`  대비율      : ${item.changeRate >= 0 ? '+' : ''}${item.changeRate}% | 캔들 색상: ${candleColor}`);
  });
}

verifySkhynixOhlc().catch(console.error);
