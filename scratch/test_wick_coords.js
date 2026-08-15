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

async function verifySamsungWickCoords() {
  console.log('Fetching Samsung Electronics (005930) raw 08/14 data...');
  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=60d');
  const trend = res.trend || [];

  // Find 08/14 item
  const item0814 = trend.find(d => (d.date === '20260814' || d.formattedDate === '08.14'));
  console.log('\n--- Samsung Electronics 08/14 Raw Prices ---');
  console.log('Date:', item0814?.date || item0814?.formattedDate);
  console.log('openPrice :', item0814?.openPrice);
  console.log('highPrice :', item0814?.highPrice);
  console.log('lowPrice  :', item0814?.lowPrice);
  console.log('closePrice:', item0814?.closePrice);

  // Compute priceToY pixel coordinates
  // Calculate priceDomain for min/max
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

  const openY = priceToY(item0814.openPrice);
  const closeY = priceToY(item0814.closePrice);
  const highY = priceToY(item0814.highPrice);
  const lowY = priceToY(item0814.lowPrice);

  console.log('\n--- Samsung Electronics 08/14 Calculated Pixel Coordinates (PRICE_CHART_CONFIG: top=10px, plotHeight=170px) ---');
  console.log(`highY  (Top Wick Tip)    : ${highY.toFixed(2)} px`);
  console.log(`openY  (Body Start)      : ${openY.toFixed(2)} px`);
  console.log(`closeY (Body End)        : ${closeY.toFixed(2)} px`);
  console.log(`lowY   (Bottom Wick Tip) : ${lowY.toFixed(2)} px`);

  console.log(`Top Wick Length    (highY to min(openY,closeY)) : ${(Math.min(openY, closeY) - highY).toFixed(2)} px`);
  console.log(`Bottom Wick Length (max(openY,closeY) to lowY)  : ${(lowY - Math.max(openY, closeY)).toFixed(2)} px`);
}

verifySamsungWickCoords();
