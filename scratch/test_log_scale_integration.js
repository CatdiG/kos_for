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
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100], tickStep: 25, useLogScale: false };
  }

  const ratio = maxRaw / minRaw;
  const useLogScale = ratio >= 2.5;

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
          minPrice: Math.max(1, startP),
          maxPrice: endP,
          priceDomain: [Math.max(1, startP), endP],
          priceTicks: ticks,
          tickStep: candidateStep,
          tickSize,
          useLogScale,
        };
      }
    }
  }

  return bestAxis;
}

function testUtiAndAltLogScale() {
  console.log('\n====================================================================================================');
  console.log('유티아이 (179900) & 알트 (459550) Log Scale 계산 테스트');
  console.log('====================================================================================================\n');

  // UTI: min = 1680, max = 24500
  const utiAxis = calculateUltraTightKrxPriceAxis(1680, 24500);
  console.log('[유티아이 179900]');
  console.log(` - useLogScale : ${utiAxis.useLogScale ? '✅ TRUE (로그 축 적용)' : 'FALSE'}`);
  console.log(` - priceDomain : [${utiAxis.minPrice.toLocaleString()}원, ${utiAxis.maxPrice.toLocaleString()}원]`);
  console.log(` - priceTicks  : ${utiAxis.priceTicks.map(t => `${t.toLocaleString()}원`).join(' / ')}\n`);

  // ALT: min = 1010, max = 2583
  const altAxis = calculateUltraTightKrxPriceAxis(1010, 2583);
  console.log('[알트 459550]');
  console.log(` - useLogScale : ${altAxis.useLogScale ? 'TRUE' : '✅ FALSE (선형 축 유지)'}`);
  console.log(` - priceDomain : [${altAxis.minPrice.toLocaleString()}원, ${altAxis.maxPrice.toLocaleString()}원]`);
  console.log(` - priceTicks  : ${altAxis.priceTicks.map(t => `${t.toLocaleString()}원`).join(' / ')}`);

  console.log('\n====================================================================================================\n');
}

testUtiAndAltLogScale();
