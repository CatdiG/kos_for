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

function getKrxTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

function calculateTightKrxPriceAxis(minRaw, maxRaw, targetTickCount = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100] };
  }

  const midPrice = (minRaw + maxRaw) / 2;
  const tickSize = getKrxTickSize(midPrice);

  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;
  const tightRange = Math.max(tickSize * 4, rawMaxBound - rawMinBound);

  const stepMultiples = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  const idealStep = Math.max(tickSize, tightRange / (targetTickCount - 1));

  let tickStep = tickSize;
  for (const m of stepMultiples) {
    const candidate = tickSize * m;
    if (candidate >= idealStep) {
      tickStep = candidate;
      break;
    }
  }

  let startP = Math.floor(rawMinBound / tickStep) * tickStep;
  let endP = Math.ceil(rawMaxBound / tickStep) * tickStep;

  if (startP === endP) {
    startP = Math.max(0, startP - tickStep * 2);
    endP = endP + tickStep * 2;
  }

  const ticks = [];
  for (let p = startP; p <= endP + tickStep * 0.01; p += tickStep) {
    ticks.push(Math.round(p));
  }

  return {
    minPrice: startP,
    maxPrice: endP,
    priceDomain: [startP, endP],
    priceTicks: ticks,
    tickStep,
    tickSize,
  };
}

async function main() {
  const symbol = '459550';
  for (const period of ['5d', '20d', '60d']) {
    const res = await fetchLocalTrend(symbol, period);
    const trend = res.trend || [];
    let min = Infinity;
    let max = -Infinity;
    let maxItemDate = '';
    let maxItemPrice = 0;

    trend.forEach(d => {
      const c = d.closePrice || 0;
      const h = d.highPrice || c;
      const l = d.lowPrice || c;
      if (h > max) {
        max = h;
        maxItemDate = d.formattedDate;
        maxItemPrice = h;
      }
      if (l < min && l > 0) {
        min = l;
      }
    });

    const axis = calculateTightKrxPriceAxis(min, max);
    console.log(`=== Period: ${period} (Total items: ${trend.length}) ===`);
    console.log(`Min Price in period: ${min}원 | Max Price in period: ${max}원 (Date: ${maxItemDate})`);
    console.log(`Calculated Tick Step: ${axis.tickStep}원`);
    console.log(`Calculated Domain: [${axis.minPrice}원, ${axis.maxPrice}원]`);
    console.log(`Calculated Ticks: [${axis.priceTicks.join(', ')}]`);
    console.log('');
  }
}

main().catch(console.error);
