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

async function verifyAlt60Candles() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 60D 차트 캔들 개수 (정확히 60개 캔들) 검증');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = res.trend || [];

    console.log(`- 백엔드 API 반환 trend 개수  : ${trend.length}개`);
    console.log(`- 60D 차트에 그려지는 캔들 수: ${Math.min(trend.length, 60)}개 (목표: 60개)`);
    console.log(`- 60D 뷰포트 시작 날짜        : ${trend[Math.max(0, trend.length - 60)]?.date}`);
    console.log(`- 60D 뷰포트 끝 날짜          : ${trend[trend.length - 1]?.date}`);

  } catch (err) {
    console.error('Error verifying ALT 60 candles:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

verifyAlt60Candles();
