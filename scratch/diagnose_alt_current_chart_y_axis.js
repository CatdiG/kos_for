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

async function diagnoseAltCurrentChartYAxis() {
  console.log('\n====================================================================================================');
  console.log('현재 알트 차트 Y축 계산 상태 정밀 진단 (Read-Only)');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const rawTrend = res.trend || [];

    console.log(`- 수신된 전체 Raw Trend 개수 : ${rawTrend.length}개`);

    // 1. Calculate Moving Averages on full raw trend
    const fullTrendWithMA = rawTrend.map((item, idx, arr) => {
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : null;

      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : null;

      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;

      return { ...item, ma5, ma20, ma60 };
    });

    const displayTrend = fullTrendWithMA.slice(-60);
    console.log(`- displayTrend (60D 뷰포트 내 캔들 개수): ${displayTrend.length}개`);

    let candleMin = Infinity;
    let candleMax = -Infinity;
    let maMax = -Infinity;
    let maMin = Infinity;
    let maMaxInfo = {};
    let maMinInfo = {};

    displayTrend.forEach((d) => {
      const c = d.closePrice;
      if (!c || c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);

      candleMin = Math.min(candleMin, o, h, l, c);
      candleMax = Math.max(candleMax, o, h, l, c);

      if (d.ma60 && d.ma60 > maMax) {
        maMax = d.ma60;
        maMaxInfo = { type: 'ma60', date: d.date, val: d.ma60 };
      }
      if (d.ma20 && d.ma20 > maMax) {
        maMax = d.ma20;
        maMaxInfo = { type: 'ma20', date: d.date, val: d.ma20 };
      }
      if (d.ma5 && d.ma5 > maMax) {
        maMax = d.ma5;
        maMaxInfo = { type: 'ma5', date: d.date, val: d.ma5 };
      }
    });

    console.log(`\n--- 1. 순수 캔들 (시가, 고가, 저가, 종가) 최저가 / 최고가 ---`);
    console.log(` - 캔들 최저가: ${candleMin}원`);
    console.log(` - 캔들 최고가: ${candleMax}원`);

    console.log(`\n--- 2. 이동평균선 (MA5, MA20, MA60) 포함 시 최저가 / 최고가 ---`);
    console.log(` - 이동평균선 최고값: ${maMax}원 (${maMaxInfo.type}, 날짜: ${maMaxInfo.date})`);

    const combinedMin = Math.min(candleMin, maMin);
    const combinedMax = Math.max(candleMax, maMax);

    const candleOnlyAxis = calculateUltraTightKrxPriceAxis(candleMin, candleMax);
    const combinedAxis = calculateUltraTightKrxPriceAxis(candleMin, combinedMax);

    console.log(`\n--- 3. Y축 계산 결과 비교 ---`);
    console.log(`[A. 캔들 가격만으로 Y축 계산 시]`);
    console.log(` - minPrice: ${candleOnlyAxis.minPrice}원, maxPrice: ${candleOnlyAxis.maxPrice}원`);
    console.log(` - priceTicks: ${candleOnlyAxis.priceTicks.join(' / ')}원`);

    console.log(`\n[B. 이동평균선(MA60)까지 포함하여 Y축 계산 시 (현재 코드 상태)]`);
    console.log(` - minPrice: ${combinedAxis.minPrice}원, maxPrice: ${combinedAxis.maxPrice}원`);
    console.log(` - priceTicks: ${combinedAxis.priceTicks.join(' / ')}원`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

diagnoseAltCurrentChartYAxis();
