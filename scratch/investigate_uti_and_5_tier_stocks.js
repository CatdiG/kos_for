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

async function runUtiInvestigation() {
  console.log('\n====================================================================================================');
  console.log('1. 유티아이 (179900) 60D RAW DATA & Y-AXIS INVESTIGATION');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=179900&period=60d');
    const trend = res.trend || [];

    console.log(`Stock Name: ${res.stockInfo?.name} (${res.stockInfo?.symbol})`);
    console.log(`isMock: ${res.isMock}`);
    console.log(`Trend Days: ${trend.length}일\n`);

    // Find 07.03 ~ 07.10 raw dates
    const JulyDates = trend.filter(d => d.date >= '20260703' && d.date <= '20260710');
    console.log('--- 유티아이 (179900) 07.03 ~ 07.10 RAW 데이터 ---');
    JulyDates.forEach(d => {
      console.log(`Date: ${d.date} | openPrice: ${d.openPrice}원 | highPrice: ${d.highPrice}원 | lowPrice: ${d.lowPrice}원 | closePrice: ${d.closePrice}원`);
    });

    // 60D Displayed Range
    const displayTrend = trend.slice(-60);
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

    const midPrice = (min + max) / 2;
    const tickSize = getKrxTickSize(midPrice);
    const axis = calculateUltraTightKrxPriceAxis(min, max);

    console.log('\n--- 유티아이 (179900) Y축 계산 입력 & 결과 ---');
    console.log(`minRaw (최저가)          : ${min}원`);
    console.log(`maxRaw (최고가)          : ${max}원`);
    console.log(`midPrice (중간값)        : ${midPrice}원`);
    console.log(`getKrxTickSize(midPrice) : ${tickSize}원`);
    console.log(`tickStep (눈금간격)      : ${axis?.tickStep}원`);
    console.log(`priceTicks (눈금목록)    : ${axis?.priceTicks.map(t => `${t.toLocaleString()}원`).join(' / ')}`);
  } catch (err) {
    console.error('Error investigating UTI:', err.message);
  }
}

runUtiInvestigation();
