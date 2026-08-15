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

async function testKisApiTickSize() {
  console.log('\n====================================================================================================');
  console.log('KIS API 실시간 종목 시세 응답 필드 확인 (459550 알트, 179900 유티아이)');
  console.log('====================================================================================================\n');

  try {
    const quotesRes = await fetchJson('http://localhost:3000/api/stock/quotes?symbols=459550,179900,257720,042660,005930');
    console.log('Quotes API Output keys:', Object.keys(quotesRes.quotes || {}));
    console.log('Quotes API Sample (459550):', quotesRes.quotes?.['459550']);
    console.log('Quotes API Sample (179900):', quotesRes.quotes?.['179900']);
  } catch (err) {
    console.error('Error fetching quotes:', err.message);
  }

  console.log('\n====================================================================================================');
}

testKisApiTickSize();
