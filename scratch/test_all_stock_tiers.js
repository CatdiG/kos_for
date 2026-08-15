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

const tiers = [
  { tier: '1. 동전주/초저가주 (1,000원 미만)', min: 620, max: 880 },
  { tier: '2. 1,000원대 저가주 (알트 등)', min: 1013, max: 2575 },
  { tier: '3. 2,000원~5,000원 중저가주', min: 3200, max: 4150 },
  { tier: '4. 10,000원~20,000원 중가주', min: 12500, max: 14800 },
  { tier: '5. 20,000원~50,000원 중고가주', min: 31500, max: 38200 },
  { tier: '6. 50,000원~200,000원 대형주 (SK하이닉스/현대차 등)', min: 165000, max: 198000 },
  { tier: '7. 200,000원~500,000원 초대형주 (삼성전자 실시세 등)', min: 230000, max: 274500 },
  { tier: '8. 500,000원 이상 초고가주 (삼성바이오/태광산업 등)', min: 510000, max: 585000 },
];

tiers.forEach(t => {
  const res = calculateUltraTightKrxPriceAxis(t.min, t.max);
  console.log(`=== ${t.tier} ===`);
  console.log(`Raw: ${t.min.toLocaleString()}원 ~ ${t.max.toLocaleString()}원 (Span: ${(t.max - t.min).toLocaleString()}원)`);
  console.log(`Tick Size: ${res.tickSize}원 | Step: ${res.tickStep}원`);
  console.log(`Calculated Domain: [${res.minPrice.toLocaleString()}원, ${res.maxPrice.toLocaleString()}원]`);
  console.log(`Ticks (${res.priceTicks.length}): [${res.priceTicks.map(x => x.toLocaleString()).join(', ')}]`);
  console.log('');
});
