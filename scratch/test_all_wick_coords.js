const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function verifyAllWickCoords() {
  const symbol = '005930';
  const res = await fetchJson(`http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=60d`);
  const trend = res.trend || [];

  let minP = Infinity;
  let maxP = -Infinity;
  trend.forEach((d) => {
    const c = d.closePrice;
    if (!c || c <= 0) return;
    const o = d.openPrice || c;
    const h = d.highPrice || Math.max(o, c);
    const l = d.lowPrice || Math.min(o, c);
    minP = Math.min(minP, o, h, l, c);
    maxP = Math.max(maxP, o, h, l, c);
  });

  const topPadding = 10;
  const plotHeight = 170;
  const priceToY = (price) => {
    return topPadding + (1 - (price - minP) / (maxP - minP)) * plotHeight;
  };

  console.log('\n--- Samsung Electronics (005930) Last 10 Days Candle Prices & Pixel Coordinates ---');
  console.log('| Date | openPrice | highPrice | lowPrice | closePrice | highY (px) | openY (px) | closeY (px) | lowY (px) | Top Wick | Bottom Wick |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');

  trend.slice(-10).forEach((d) => {
    const openY = priceToY(d.openPrice);
    const closeY = priceToY(d.closePrice);
    const highY = priceToY(d.highPrice);
    const lowY = priceToY(d.lowPrice);

    const topWickLen = Math.min(openY, closeY) - highY;
    const botWickLen = lowY - Math.max(openY, closeY);

    console.log(`| ${d.date} | ${d.openPrice} | ${d.highPrice} | ${d.lowPrice} | ${d.closePrice} | ${highY.toFixed(1)} | ${openY.toFixed(1)} | ${closeY.toFixed(1)} | ${lowY.toFixed(1)} | ${topWickLen.toFixed(1)}px | ${botWickLen.toFixed(1)}px |`);
  });
}

verifyAllWickCoords();
