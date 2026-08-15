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

async function testAlt60dPagination() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) KIS API 페이지네이션 및 60일+ 데이터 수신 테스트');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    console.log(`- API 응답 Trend 데이터 개수 : ${res.trend?.length}일`);
    console.log(`- isMock                     : ${res.isMock}`);
    if (res.trend && res.trend.length > 0) {
      console.log(`- 수신된 가장 오래된 날짜    : ${res.trend[0].date}`);
      console.log(`- 수신된 가장 최근 날짜      : ${res.trend[res.trend.length - 1].date}`);
    }
  } catch (err) {
    console.error('Error during pagination test:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

testAlt60dPagination();
