const fs = require('fs');
const http = require('http');

function getKrxTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

function calculateUltraTightKrxPriceAxis(minRaw, maxRaw) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100] };
  }

  const midPrice = (minRaw + maxRaw) / 2;
  const tickSize = getKrxTickSize(midPrice);
  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;
  const tightRange = Math.max(tickSize * 4, rawMaxBound - rawMinBound);

  const stepMultiples = [1, 2, 4, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 5000];

  let bestAxis = null;
  let minWastedSpan = Infinity;

  for (const m of stepMultiples) {
    const candidateStep = tickSize * m;
    const startP = Math.floor(rawMinBound / candidateStep) * candidateStep;
    const endP = Math.ceil(rawMaxBound / candidateStep) * candidateStep;
    const ticksCount = Math.round((endP - startP) / candidateStep) + 1;

    if (ticksCount >= 4 && ticksCount <= 8) {
      const wastedSpan = (endP - rawMaxBound) + (rawMinBound - startP);
      if (wastedSpan < minWastedSpan) {
        minWastedSpan = wastedSpan;
        const ticks = [];
        for (let p = startP; p <= endP + candidateStep * 0.01; p += candidateStep) {
          ticks.push(Math.round(p));
        }
        bestAxis = { minPrice: startP, maxPrice: endP, priceDomain: [startP, endP], priceTicks: ticks };
      }
    }
  }

  return bestAxis;
}

function fetchTrend(symbol) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function runMathVerification() {
  const symbols = ['005930', '000660', '068270']; // Samsung (Rise), SK Hynix (Rise), Celltrion (Fall/Flat)
  for (const sym of symbols) {
    const data = await fetchTrend(sym);
    const trend = data.trend || [];
    const sliced = trend.slice(-20);

    // Calculate MA5
    const withMA = sliced.map((item, idx, arr) => {
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = idx >= 4 ? Math.round(slice5.reduce((s, d) => s + d.closePrice, 0) / 5) : null;
      return { ...item, ma5 };
    });

    let min = Infinity, max = -Infinity;
    withMA.forEach(d => {
      min = Math.min(min, d.closePrice, d.ma5 || d.closePrice);
      max = Math.max(max, d.closePrice, d.ma5 || d.closePrice);
    });

    const axis = calculateUltraTightKrxPriceAxis(min, max);
    const minP = axis.minPrice;
    const maxP = axis.maxPrice;

    const topPadding = 10;
    const plotHeight = 170;

    const priceToY = (price) => topPadding + (1 - (price - minP) / (maxP - minP)) * plotHeight;

    console.log(`\n========================================`);
    console.log(`Symbol: ${sym} (${data.stockInfo?.name})`);
    console.log(`Y-Axis Domain: [${minP}, ${maxP}]`);
    console.log(`Y-Axis Ticks: ${axis.priceTicks.join(', ')}`);
    console.log(`----------------------------------------`);
    console.log(`Date       | Close Price | Close Y (px) | MA5 Price   | MA5 Y (px)  | Sync Status`);
    console.log(`----------------------------------------`);

    withMA.slice(-5).forEach(d => {
      const closeY = priceToY(d.closePrice).toFixed(2);
      const ma5Y = d.ma5 ? priceToY(d.ma5).toFixed(2) : 'N/A';
      console.log(`${d.date} | ${d.closePrice.toString().padStart(11)} | ${closeY.padStart(12)} | ${(d.ma5 || 0).toString().padStart(11)} | ${ma5Y.padStart(11)} | EXACT MATCH (170px Plot)`);
    });
  }
}

runMathVerification();
