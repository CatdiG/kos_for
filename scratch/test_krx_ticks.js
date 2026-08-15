/**
 * Helper function: KRX Price Tier Tick Size (호가단위)
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
 * Calculates KRX tick-aligned Y-axis Domain and Ticks
 */
function calculateKrxPriceAxis(minRaw, maxRaw, targetTickCount = 5) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= minRaw) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100], tickStep: 25 };
  }

  const midPrice = (minRaw + maxRaw) / 2;
  const baseTick = getKrxTickSize(midPrice);

  // Raw price range with 5% padding
  const rawRange = maxRaw - minRaw;
  const pad = rawRange * 0.05 || Math.max(baseTick * 2, midPrice * 0.01);
  let minP = Math.max(0, minRaw - pad);
  let maxP = maxRaw + pad;

  const paddedRange = maxP - minP;
  let rawStep = paddedRange / (targetTickCount - 1);

  // Ensure rawStep is at least 1 baseTick
  rawStep = Math.max(rawStep, baseTick);

  // Snap rawStep to a clean multiple of baseTick
  // Standard multiplier sequences: 1, 2, 2.5, 5, 10, 20, 25, 50, 100...
  const multiples = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  let tickStep = baseTick;
  for (const m of multiples) {
    const candidate = baseTick * m;
    if (candidate >= rawStep) {
      tickStep = Math.round(candidate);
      break;
    }
  }

  // Snap minP down and maxP up to tickStep
  let startP = Math.floor(minP / tickStep) * tickStep;
  let endP = Math.ceil(maxP / tickStep) * tickStep;

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
    baseTick,
  };
}

// Test cases
const testCases = [
  { name: '알트 (1930 ~ 2575원)', min: 1930, max: 2575 },
  { name: '저가주 (1200 ~ 1650원)', min: 1200, max: 1650 },
  { name: '중가주 (3200 ~ 4400원)', min: 3200, max: 4400 },
  { name: '중고가주 (12500 ~ 14800원)', min: 12500, max: 14800 },
  { name: '삼성전자급 (65000 ~ 72500원)', min: 65000, max: 72500 },
  { name: 'SK하이닉스급 (185000 ~ 220000원)', min: 185000, max: 220000 },
  { name: '고가주 (480000 ~ 560000원)', min: 480000, max: 560000 },
];

testCases.forEach(tc => {
  const res = calculateKrxPriceAxis(tc.min, tc.max);
  console.log(`=== ${tc.name} ===`);
  console.log(`Base Tick(aspr_unit): ${res.baseTick}원 | Tick Step: ${res.tickStep}원`);
  console.log(`Domain: [${res.minPrice.toLocaleString()}원, ${res.maxPrice.toLocaleString()}원]`);
  console.log(`Ticks: [${res.priceTicks.map(t => t.toLocaleString()).join(', ')}]`);
  console.log('');
});
