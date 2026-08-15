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

async function diagnoseUtiCandleIssue() {
  console.log('\n====================================================================================================');
  console.log('[유티아이 (179900) 캔들 미표시 원인 정밀 진단]');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=179900&period=60d');
    const trend = res.trend || [];

    console.log(`- API 응답 Trend 개수 : ${trend.length}개`);
    console.log(`- isMock              : ${res.isMock}`);
    console.log(`- stockInfo           : ${JSON.stringify(res.stockInfo || {})}\n`);

    if (trend.length === 0) {
      console.log('❌ [원인 1] trend 배열이 0개(빈 배열)로 들어옵니다!');
      return;
    }

    console.log('--- 유티아이 최근 10일치 OHLC 데이터 검증 ---');
    console.log('| Date | openPrice | highPrice | lowPrice | closePrice |');
    console.log('|---|---|---|---|---|');

    let invalidOhlcCount = 0;
    trend.slice(-10).forEach(d => {
      const isValid = d.openPrice > 0 && d.highPrice > 0 && d.lowPrice > 0 && d.closePrice > 0;
      if (!isValid) invalidOhlcCount++;
      console.log(`| ${d.date} | ${d.openPrice}원 | ${d.highPrice}원 | ${d.lowPrice}원 | ${d.closePrice}원 | ${isValid ? '✅ 정상' : '❌ 0 또는 비정상'}`);
    });

    // Check min/max domain calculation
    let min = Infinity;
    let max = -Infinity;
    trend.slice(-60).forEach((d) => {
      const c = d.closePrice;
      if (!c || c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);
      min = Math.min(min, o, h, l, c);
      max = Math.max(max, o, h, l, c);
    });

    console.log(`\n- 60D 뷰포트 최저가(minRaw): ${min}원`);
    console.log(`- 60D 뷰포트 최고가(maxRaw): ${max}원`);
    console.log(`- minPrice / maxPrice 유효성: ${min < max && min > 0 ? '✅ 정상 범위' : '❌ 비정상 (min >= max 또는 min <= 0)'}`);

  } catch (err) {
    console.error('Diagnostic error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

diagnoseUtiCandleIssue();
