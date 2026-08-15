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

async function testYesuntechFix() {
  console.log('=== Testing Sanitized Y-Axis Domain Calculation for 예선테크 (250930) ===');
  const data = await fetchJson('/api/stock/investor-trend?symbol=250930&period=20d');

  if (!data || !data.trend) return;

  let min = Infinity;
  let max = -Infinity;

  data.trend.forEach((d) => {
    const c = d.closePrice;
    if (!c || c <= 0) return;
    const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
    const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
    const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);
    const ma5 = (d.ma5 && d.ma5 > 0) ? d.ma5 : c;
    const ma20 = (d.ma20 && d.ma20 > 0) ? d.ma20 : c;
    const ma60 = (d.ma60 && d.ma60 > 0) ? d.ma60 : c;

    min = Math.min(min, o, h, l, c, ma5, ma20, ma60);
    max = Math.max(max, o, h, l, c, ma5, ma20, ma60);
  });

  console.log(`Sanitized Min Price: ${min}원, Max Price: ${max}원, Delta: ${max - min}원`);

  const pad = (max - min) * 0.05 || 100;
  const minP = Math.floor(min - pad);
  const maxP = Math.ceil(max + pad);

  console.log(`Sanitized Domain: [${minP}, ${maxP}]`);

  const topPadding = 10;
  const chartHeight = 190;
  const priceToY = (price) => topPadding + (1 - (price - minP) / (maxP - minP)) * chartHeight;

  console.log(`priceToY(min = ${min}): ${priceToY(min).toFixed(1)}px (Near bottom)`);
  console.log(`priceToY(max = ${max}): ${priceToY(max).toFixed(1)}px (Near top)`);
  console.log(`priceToY(close[0] = ${data.trend[0].closePrice}): ${priceToY(data.trend[0].closePrice).toFixed(1)}px`);
}

testYesuntechFix().catch(console.error);
