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

async function inspectUtiMaxPrice() {
  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=179900&period=60d');
  const trend = res.trend || [];
  const display60 = trend.slice(-60);

  console.log('\n--- 유티아이 최근 60일 캔들 중 가격이 이상한 날짜 찾기 ---');
  display60.forEach((d) => {
    if (d.highPrice > 6000 || d.closePrice > 6000) {
      console.log(`[이상 날짜 발견!] Date: ${d.date} | open: ${d.openPrice}원 | high: ${d.highPrice}원 | low: ${d.lowPrice}원 | close: ${d.closePrice}원`);
    }
  });
}

inspectUtiMaxPrice();
