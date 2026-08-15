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

async function explainTradingVsCalendarDays() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 영업일(Trading Days) vs 달력일(Calendar Days) 날짜 계산 비교');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = res.trend || [];

    console.log(`- 수신된 총 영업일수 (캔들 개수) : ${trend.length}개`);
    console.log(`- 가장 최근 날짜 (8월 14일)    : ${trend[trend.length - 1]?.date}`);

    // Index 30 days ago (30 영업일 전)
    const idx30 = Math.max(0, trend.length - 30);
    console.log(`- 최근 30개 캔들 (30 영업일 전) 시작 날짜: ${trend[idx30]?.date} (7월 3일!)`);

    // Index 60 days ago (60 영업일 전)
    const idx60 = Math.max(0, trend.length - 60);
    console.log(`- 최근 60개 캔들 (60 영업일 전) 시작 날짜: ${trend[idx60]?.date} (5월 20일!)`);

    console.log('\n--- 날짜 범위 정리 ---');
    console.log('1) [7월 3일 ~ 8월 14일] : 달력으로는 약 42일 차이 / 주식 거래일(캔들)로는 딱 **30 영업일** (30개 캔들)');
    console.log('2) [6월 15일 ~ 8월 14일] : 달력으로 딱 **60 달력일** 차이 / 주식 거래일(캔들)로는 약 **42 영업일** (42개 캔들)');
    console.log('3) [5월 20일 ~ 8월 14일] : 달력으로는 약 86일 차이 / 주식 거래일(캔들)로는 딱 **60 영업일** (60개 캔들)');

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

explainTradingVsCalendarDays();
