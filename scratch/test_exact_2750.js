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

function calculateUltraTightKrxPriceAxis(minRaw, maxRaw) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100], tickStep: 25 };
  }

  const midPrice = (minRaw + maxRaw) / 2;
  const tickSize = getKrxTickSize(midPrice);

  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;

  const stepMultiples = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

  let bestAxis = null;
  let minWastedSpan = Infinity;

  for (const m of stepMultiples) {
    const candidateStep = tickSize * m;
    const startP = Math.floor(rawMinBound / candidateStep) * candidateStep;
    const endP = Math.ceil(rawMaxBound / candidateStep) * candidateStep;
    const ticksCount = Math.round((endP - startP) / candidateStep) + 1;

    if (ticksCount >= 4 && ticksCount <= 10) {
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

  return bestAxis;
}

async function testExact2750() {
  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
  const trend = res.trend || [];

  const fullTrendWithMA = trend.map((item, idx, arr) => {
    const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
    const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : null;
    const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
    const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : null;
    const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
    const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;
    return { ...item, ma5, ma20, ma60 };
  });

  const displayTrend = fullTrendWithMA.slice(-60);

  let min = Infinity;
  let max = -Infinity;
  displayTrend.forEach((d) => {
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

  console.log('--- ALT (459550) Exact 2,750원 Test ---');
  console.log(`minRaw: ${min}원 | maxRaw: ${max}원`);

  const axis = calculateUltraTightKrxPriceAxis(min, max);
  console.log('\n--- Calculated Y-Axis Result ---');
  console.log('minPrice (Y축 최하단) :', axis.minPrice, '원');
  console.log('maxPrice (Y축 최상단) :', axis.maxPrice, '원');
  console.log('tickStep (눈금 간격) :', axis.tickStep, '원');
  console.log('priceTicks (전체 눈금 목록):', axis.priceTicks.map(t => `${t.toLocaleString()}원`).join(' / '));
}

testExact2750();
