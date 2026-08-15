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
        };
      }
    }
  }

  return bestAxis;
}

async function verifyAltNaverHtsStandardYAxis() {
  console.log('\n====================================================================================================');
  console.log('네이버 증권 / 한투 HTS 표준(순수 캔들 기준) 알트 (459550) Y축 검증');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = (res.trend || []).slice(-60);

    let min = Infinity;
    let max = -Infinity;
    trend.forEach((d) => {
      const c = d.closePrice;
      if (!c || c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);

      min = Math.min(min, o, h, l, c);
      max = Math.max(max, o, h, l, c);
    });

    const axis = calculateUltraTightKrxPriceAxis(min, max);

    console.log(`- 60D 캔들 최저가 (minRaw) : ${min}원`);
    console.log(`- 60D 캔들 최고가 (maxRaw) : ${max}원`);
    console.log(`- **Y축 최하단 (minPrice)** : **${axis.minPrice.toLocaleString()}원**`);
    console.log(`- **Y축 최상단 (maxPrice)** : **${axis.maxPrice.toLocaleString()}원** (확정 2,750원)`);
    console.log(`- Y축 눈금 간격 (tickStep)  : ${axis.tickStep.toLocaleString()}원`);
    console.log(`- Y축 표시 눈금 목록        : ${axis.priceTicks.map(t => `${t.toLocaleString()}원`).join(' / ')}`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

verifyAltNaverHtsStandardYAxis();
