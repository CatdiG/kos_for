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

  // Dynamic granular step candidates (multiples of tickSize)
  const stepMultiples = [1, 2, 4, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 5000];

  // Try candidate steps to find the one that covers [rawMinBound, rawMaxBound] with minimal top/bottom waste
  let bestAxis = null;
  let minWastedSpan = Infinity;

  for (const m of stepMultiples) {
    const candidateStep = tickSize * m;
    const startP = Math.floor(rawMinBound / candidateStep) * candidateStep;
    const endP = Math.ceil(rawMaxBound / candidateStep) * candidateStep;
    const ticksCount = Math.round((endP - startP) / candidateStep) + 1;

    // We want target 5~8 ticks
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

  // Fallback if no best axis found within count 4~8
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

const min = 1013;
const max = 2575;
const axis = calculateUltraTightKrxPriceAxis(min, max);
console.log(`=== Alt Test (min=${min}, max=${max}) ===`);
console.log(`Tick Size: ${axis.tickSize}원 | Step: ${axis.tickStep}원`);
console.log(`Calculated Domain: [${axis.minPrice}원, ${axis.maxPrice}원]`);
console.log(`Calculated Ticks (${axis.priceTicks.length}): [${axis.priceTicks.join(', ')}]`);
