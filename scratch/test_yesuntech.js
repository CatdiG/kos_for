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

async function testYesuntech() {
  console.log('=== Fetching Raw API Data for 예선테크 (250930) ===');
  const data = await fetchJson('/api/stock/investor-trend?symbol=250930&period=20d');

  if (!data) {
    console.log('API returned null/error');
    return;
  }

  console.log('Stock Info:', data.stockInfo);
  console.log(`Total trend items: ${data.trend?.length || 0}`);

  if (data.trend && data.trend.length > 0) {
    console.log('Sample Trend Item 0 (Leftmost):', data.trend[0]);
    console.log('Sample Trend Item Latest (Rightmost):', data.trend[data.trend.length - 1]);

    // Check min / max calculation
    let min = Infinity;
    let max = -Infinity;
    data.trend.forEach((d) => {
      const o = d.openPrice ?? d.closePrice;
      const h = d.highPrice ?? Math.max(o, d.closePrice);
      const l = d.lowPrice ?? Math.min(o, d.closePrice);
      const c = d.closePrice;
      min = Math.min(min, o, h, l, c);
      max = Math.max(max, o, h, l, c);
    });

    console.log(`Min Price: ${min}, Max Price: ${max}, Delta: ${max - min}`);

    const pad = (max - min) * 0.05 || 100;
    const minP = Math.floor(min - pad);
    const maxP = Math.ceil(max + pad);

    console.log(`Domain: [${minP}, ${maxP}]`);
    
    // Check if priceToY works
    const topPadding = 10;
    const chartHeight = 190;
    const priceToY = (price) => topPadding + (1 - (price - minP) / (maxP - minP)) * chartHeight;

    console.log(`priceToY(min): ${priceToY(min)}px`);
    console.log(`priceToY(max): ${priceToY(max)}px`);
    console.log(`priceToY(close[0]): ${priceToY(data.trend[0].closePrice)}px`);
  }
}

testYesuntech().catch(console.error);
