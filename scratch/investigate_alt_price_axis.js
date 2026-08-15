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

function getKrxTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

function calculateUltraTightKrxPriceAxis(minRaw, maxRaw, targetTickCount = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100], tickStep: 25 };
  }

  // KRX tick size determined by maxRaw (current price level)
  const tickSize = getKrxTickSize(maxRaw);

  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;
  const tightRange = Math.max(tickSize * 4, rawMaxBound - rawMinBound);

  // Step multiples as integer multiples of tickSize
  const stepMultiples = [1, 2, 4, 5, 10, 20, 25, 40, 50, 100, 200, 250, 400, 500, 1000];

  let bestAxis = null;
  let minWastedSpan = Infinity;

  for (const m of stepMultiples) {
    const candidateStep = tickSize * m; // Always an exact integer multiple of tickSize (e.g. 5, 10, 25, 50, 100, 250, 500)
    const startP = Math.floor(rawMinBound / candidateStep) * candidateStep;
    const endP = Math.ceil(rawMaxBound / candidateStep) * candidateStep;
    const ticksCount = Math.round((endP - startP) / candidateStep) + 1;

    if (ticksCount >= 4 && ticksCount <= 7) {
      const wastedSpan = (endP - rawMaxBound) + (rawMinBound - startP);
      if (wastedSpan < minWastedSpan) {
        minWastedSpan = wastedSpan;
        const ticks = [];
        for (let p = startP; p <= endP + candidateStep * 0.01; p += candidateStep) {
          ticks.push(Math.round(p));
        }
        bestAxis = {
          minPrice: startP,
          maxPrice: endP,
          priceDomain: [startP, endP],
          priceTicks: ticks,
          tickStep: candidateStep,
          tickSize,
          ticksCount,
        };
      }
    }
  }

  if (!bestAxis) {
    const fallbackStep = Math.max(tickSize, Math.ceil((tightRange / 5) / tickSize) * tickSize);
    const startP = Math.floor(rawMinBound / fallbackStep) * fallbackStep;
    const endP = Math.ceil(rawMaxBound / fallbackStep) * fallbackStep;
    const ticks = [];
    for (let p = startP; p <= endP + fallbackStep * 0.01; p += fallbackStep) {
      ticks.push(Math.round(p));
    }
    bestAxis = { minPrice: startP, maxPrice: endP, priceDomain: [startP, endP], priceTicks: ticks, tickStep: fallbackStep, tickSize, ticksCount: ticks.length };
  }

  return bestAxis;
}

async function testAltPriceAxisFixed() {
  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
  const trend = res.trend || [];

  let min = Infinity;
  let max = -Infinity;
  trend.forEach((d) => {
    const c = d.closePrice;
    if (!c || c <= 0) return;
    const o = d.openPrice || c;
    const h = d.highPrice || Math.max(o, c);
    const l = d.lowPrice || Math.min(o, c);
    const ma5 = d.ma5 || c;
    const ma20 = d.ma20 || c;
    const ma60 = d.ma60 || c;
    min = Math.min(min, o, h, l, c, ma5, ma20, ma60);
    max = Math.max(max, o, h, l, c, ma5, ma20, ma60);
  });

  console.log('--- FIXED ALT (459550) 60D Price Axis Output ---');
  console.log(`minRaw: ${min}원 | maxRaw: ${max}원`);
  console.log(`getKrxTickSize(2575) = ${getKrxTickSize(2575)}원 (5원 단위 확정)`);
  console.log(`getKrxTickSize(maxRaw=${max}) = ${getKrxTickSize(max)}원`);

  const axis = calculateUltraTightKrxPriceAxis(min, max, 6);
  console.log('\n--- Calculated Axis Result ---');
  console.log('minPrice  :', axis.minPrice, '원');
  console.log('maxPrice  :', axis.maxPrice, '원');
  console.log('tickSize  :', axis.tickSize, '원');
  console.log('tickStep  :', axis.tickStep, `원 (${axis.tickStep / axis.tickSize} 배수)`);
  console.log('priceTicks:', axis.priceTicks.map(t => `${t.toLocaleString()}원`).join(' / '));
  console.log('Is tickStep an exact integer multiple of tickSize?', axis.tickStep % axis.tickSize === 0);
}

testAltPriceAxisFixed();
