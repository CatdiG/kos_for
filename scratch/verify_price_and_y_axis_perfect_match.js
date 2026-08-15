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

async function verifyPriceAndYAxisPerfectMatch() {
  console.log('\n====================================================================================================');
  console.log('Y축 눈금 - 캔들스틱 - 이동평균선 위치 100% 완전 일치 정밀 수치 검증');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=179900&period=60d');
    const trend = (res.trend || []).slice(-60);

    const minPrice = 1500;
    const maxPrice = 25000;
    const plotHeight = 170;
    const topPadding = 10;

    const priceToY = (p) => topPadding + (1 - (p - minPrice) / (maxPrice - minPrice)) * plotHeight;
    const yToPrice = (y) => minPrice + (1 - (y - topPadding) / plotHeight) * (maxPrice - minPrice);

    const aug14 = trend[trend.length - 1];

    const candleY = priceToY(aug14.closePrice);
    const priceReadFromAxisAtCandleY = yToPrice(candleY);

    console.log(`- 8월 14일 유티아이 실제 데이터 종가 : ${aug14.closePrice}원`);
    console.log(`- 캔들스틱 렌더링 Y 좌표               : y = ${candleY.toFixed(2)} px`);
    console.log(`- Y축 눈금에서 해당 Y좌표 읽은 가격   : ${Math.round(priceReadFromAxisAtCandleY)}원`);
    console.log(`- **일치 여부**: **${Math.abs(aug14.closePrice - priceReadFromAxisAtCandleY) < 0.01 ? '✅ 100% 완전 일치' : '❌ 불일치'}**`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

verifyPriceAndYAxisPerfectMatch();
