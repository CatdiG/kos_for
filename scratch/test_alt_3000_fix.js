function getKrxTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

function calculateUltraTightPriceAxis(minRaw, maxRaw, targetTickCount = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100], priceTicks: [0, 25, 50, 75, 100] };
  }

  const midPrice = (minRaw + maxRaw) / 2;
  const tickSize = getKrxTickSize(midPrice);

  // Bounds: min - 2*tickSize ~ max + 2*tickSize
  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;
  const tightRange = Math.max(tickSize * 4, rawMaxBound - rawMinBound);

  // Dynamic granular step candidates (multiples of tickSize)
  // Include 1, 2, 4, 5, 10, 20, 25, 30, 40, 50, 60, 80, 100...
  const stepMultiples = [1, 2, 4, 5, 10, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 800, 1000, 2000, 2500, 5000];
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

  // If endP overshoots maxRaw by more than 1 step, shrink startP/endP or use a tighter step
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

// Test Alt (min=1013, max=2575)
const min = 1013;
const max = 2575;
const res = calculateUltraTightPriceAxis(min, max);
console.log(`=== Alt Test (min=${min}, max=${max}) ===`);
console.log(`Tick Step: ${res.tickStep}원`);
console.log(`Domain: [${res.minPrice}원, ${res.maxPrice}원]`);
console.log(`Ticks (${res.priceTicks.length}): [${res.priceTicks.join(', ')}]`);
