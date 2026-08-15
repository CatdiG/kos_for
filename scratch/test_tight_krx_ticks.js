/**
 * KRX Price Tier Tick Size (호가단위)
 */
function getKrxTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/**
 * Calculates Tight Tick-based Y-axis Domain and Ticks
 * 1. No percentage padding (0% ratio padding).
 * 2. Tight margin: max + 2 * tickSize, min - 2 * tickSize.
 * 3. Dense ticks: 5~7 ticks cleanly stepping by tight multiples of tickSize.
 */
function calculateTightKrxPriceAxis(minRaw, maxRaw, targetTickCount = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= minRaw) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100], tickStep: 25 };
  }

  const midPrice = (minRaw + maxRaw) / 2;
  const tickSize = getKrxTickSize(midPrice);

  // 1 & 2. Tight tick-based bounds without percentage padding
  // Top: maxRaw + 2 * tickSize, snapped up to tickSize
  // Bottom: minRaw - 2 * tickSize, snapped down to tickSize
  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;

  const tightRange = rawMaxBound - rawMinBound;

  // 3. Fine-grained step candidate multiples of tickSize
  const stepMultiples = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  let idealStep = tightRange / (targetTickCount - 1);
  idealStep = Math.max(idealStep, tickSize);

  let tickStep = tickSize;
  for (const m of stepMultiples) {
    const candidate = tickSize * m;
    if (candidate >= idealStep) {
      tickStep = candidate;
      break;
    }
  }

  // Snap bounds to tickStep
  let startP = Math.floor(rawMinBound / tickStep) * tickStep;
  let endP = Math.ceil(rawMaxBound / tickStep) * tickStep;

  if (startP === endP) {
    startP = Math.max(0, startP - tickStep);
    endP = endP + tickStep;
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
    rangeCoverage: `${startP} ~ ${endP} (Range height: ${endP - startP})`
  };
}

// Test cases
const testCases = [
  { name: '알트 8/14 실데이터 (1930 ~ 2575원)', min: 1930, max: 2575 },
  { name: '알트 20일 좁은 범위 (1950 ~ 2150원)', min: 1950, max: 2150 },
  { name: '저가주 (1200 ~ 1350원)', min: 1200, max: 1350 },
  { name: '중가주 (3200 ~ 3600원)', min: 3200, max: 3600 },
  { name: '삼성전자 (68000 ~ 71000원)', min: 68000, max: 71000 },
  { name: 'SK하이닉스 (195000 ~ 205000원)', min: 195000, max: 205000 },
];

testCases.forEach(tc => {
  const res = calculateTightKrxPriceAxis(tc.min, tc.max);
  console.log(`=== ${tc.name} ===`);
  console.log(`Raw Range: ${tc.min} ~ ${tc.max} (Span: ${tc.max - tc.min})`);
  console.log(`Tick Size: ${res.tickSize}원 | Step: ${res.tickStep}원`);
  console.log(`Tight Domain: [${res.minPrice.toLocaleString()}원, ${res.maxPrice.toLocaleString()}원]`);
  console.log(`Ticks (${res.priceTicks.length}): [${res.priceTicks.map(t => t.toLocaleString()).join(', ')}]`);
  console.log('');
});
