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

async function verifyAllStocks60Candles() {
  const stocks = [
    { symbol: '459550', name: '알트' },
    { symbol: '179900', name: '유티아이' },
    { symbol: '005930', name: '삼성전자' },
    { symbol: '000660', name: 'SK하이닉스' },
    { symbol: '042660', name: '한화오션' },
  ];

  console.log('\n====================================================================================================');
  console.log('전 종목 60D 차트 캔들 개수(60개) 및 60일 전 시작 날짜 전수 검증');
  console.log('====================================================================================================\n');

  for (const s of stocks) {
    try {
      const res = await fetchJson(`http://localhost:3000/api/stock/investor-trend?symbol=${s.symbol}&period=60d`);
      const trend = res.trend || [];
      const display60 = trend.slice(-60);

      console.log(`[${s.name} (${s.symbol})]`);
      console.log(` - 백엔드 수신 전체 캔들 수 : ${trend.length}개`);
      console.log(` - 60D 차트에 그려지는 캔들 수: ${display60.length}개 (${display60.length === 60 ? '✅ 정확히 60개' : '❌ 60개 미달'})`);
      console.log(` - 60D 차트 시작 날짜 (1일차) : ${display60[0]?.date}`);
      console.log(` - 60D 차트 종료 날짜 (60일차): ${display60[display60.length - 1]?.date}\n`);
    } catch (err) {
      console.error(`Error verifying ${s.name}:`, err.message);
    }
  }

  console.log('====================================================================================================\n');
}

verifyAllStocks60Candles();
