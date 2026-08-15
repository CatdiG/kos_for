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

async function verifyAlt60dMa60Complete() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 60일 완결 이동평균선(MA60) 서버 API 통합 검증');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = res.trend || [];

    console.log(`- 백엔드 수신 전체 Trend 데이터 개수 : ${trend.length}일 (>=60일 완결: ${trend.length >= 60})`);

    // Calculate full 60d MA over the full trend array
    const fullTrendWithMA = trend.map((item, idx, arr) => {
      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.length >= 60 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / 60) : null;
      return { ...item, ma60 };
    });

    const display60 = fullTrendWithMA.slice(-60);

    console.log('\n--- 60D 뷰포트 내 첫 날짜 및 최근 날짜 60일 완결 ma60 수치 ---');
    console.log(`- 첫 날짜 (${display60[0].date}) ma60 : ${display60[0].ma60}원 (선행 60일 완결 평균)`);
    console.log(`- 최근 날짜 (${display60[59].date}) ma60: ${display60[59].ma60}원 (선행 60일 완결 평균)`);

    console.log('\n--- 알트 최근 10일치 raw 종가 및 60일 완결 ma60 표 ---');
    console.log('| Date | closePrice | ma60 (60일 완결 평균) |');
    console.log('|---|---|---|');
    display60.slice(-10).forEach(d => {
      console.log(`| ${d.date} | ${d.closePrice}원 | ${d.ma60}원 |`);
    });

  } catch (err) {
    console.error('Error verifying ALT 60d MA60 complete:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

verifyAlt60dMa60Complete();
