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

async function diagnoseAltMaReadOnly() {
  console.log('\n====================================================================================================');
  console.log('[READ-ONLY 진단] 알트 (459550) 이동평균선(MA5, MA20, MA60) 데이터 및 파이프라인 정밀 분석');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = res.trend || [];

    console.log(`- API 응답 일수 : ${trend.length}일`);
    console.log(`- isMock        : ${res.isMock}`);
    console.log(`- stockInfo     : ${JSON.stringify(res.stockInfo || {})}\n`);

    console.log('--- 알트 최근 10일치 raw 데이터 및 MA 계산값 확인 ---');
    console.log('| Date | closePrice | ma5 | ma20 | ma60 |');
    console.log('|---|---|---|---|---|');

    // Calculate MAs on full array
    const fullTrendWithMA = trend.map((item, idx, arr) => {
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : null;
      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : null;
      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;
      return { ...item, ma5, ma20, ma60 };
    });

    fullTrendWithMA.slice(-10).forEach(d => {
      console.log(`| ${d.date} | ${d.closePrice}원 | ${d.ma5}원 | ${d.ma20}원 | ${d.ma60}원 |`);
    });

    // Check if ma60 has nulls or if array length < 60
    const nullMa60Count = fullTrendWithMA.filter(d => d.ma60 === null || d.ma60 === undefined).length;
    console.log(`\n- ma60 Null 개수 (전체 ${fullTrendWithMA.length}개 중): ${nullMa60Count}개`);

  } catch (err) {
    console.error('Error during read-only diagnosis:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

diagnoseAltMaReadOnly();
