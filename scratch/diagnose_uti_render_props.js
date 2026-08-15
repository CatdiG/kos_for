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
  const tightRange = Math.max(tickSize * 4, rawMaxBound - rawMinBound);

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
    bestAxis = { minPrice: startP, maxPrice: endP, priceDomain: [startP, endP], priceTicks: ticks, tickStep: fallbackStep, tickSize };
  }

  return bestAxis;
}

async function diagnoseUtiRenderProps() {
  console.log('\n====================================================================================================');
  console.log('유티아이 (179900) CandlestickBar 렌더링 멸실 원인 수치 진단');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=179900&period=60d');
    const trend = (res.trend || []).slice(-60);

    let min = Infinity;
    let max = -Infinity;
    trend.forEach((d) => {
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

    const axis = calculateUltraTightKrxPriceAxis(min, max);

    console.log(`- minRaw : ${min}원, maxRaw : ${max}원`);
    console.log(`- minPrice: ${axis.minPrice}원, maxPrice: ${axis.maxPrice}원`);
    console.log(`- priceTicks: ${axis.priceTicks.join(' / ')}원`);

    const topPadding = 10;
    const plotHeight = 170;
    const priceToY = (p) => topPadding + (1 - (p - axis.minPrice) / (axis.maxPrice - axis.minPrice)) * plotHeight;

    const aug14 = trend[trend.length - 1];
    const openY = priceToY(aug14.openPrice);
    const closeY = priceToY(aug14.closePrice);
    const highY = priceToY(aug14.highPrice);
    const lowY = priceToY(aug14.lowPrice);

    console.log(`\n--- 8월 14일 캔들 좌표 (종가 ${aug14.closePrice}원) ---`);
    console.log(`- openY  : ${openY.toFixed(2)} px`);
    console.log(`- closeY : ${closeY.toFixed(2)} px`);
    console.log(`- highY  : ${highY.toFixed(2)} px`);
    console.log(`- lowY   : ${lowY.toFixed(2)} px`);
    console.log(`- candleY (Math.min(openY, closeY)): ${Math.min(openY, closeY).toFixed(2)} px`);
    console.log(`- candleHeight (Math.max(abs(closeY - openY), 4)): ${Math.max(Math.abs(closeY - openY), 4).toFixed(2)} px`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

diagnoseUtiRenderProps();
