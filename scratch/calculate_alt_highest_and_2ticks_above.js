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

function getKrxTickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

async function calculateAltHighestAnd2TicksAbove() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 최근 60일 최고가 및 2호가 위 가격 산출');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = (res.trend || []).slice(-60);

    let maxPrice = -Infinity;
    let maxDate = '';

    trend.forEach((d) => {
      const c = d.closePrice || 0;
      if (c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);

      const dayMax = Math.max(o, h, l, c);
      if (dayMax > maxPrice) {
        maxPrice = dayMax;
        maxDate = d.date;
      }
    });

    const tick1Size = getKrxTickSize(maxPrice);
    const price1TickAbove = maxPrice + tick1Size;
    const tick2Size = getKrxTickSize(price1TickAbove);
    const price2TicksAbove = price1TickAbove + tick2Size;

    console.log(`- 알트 최근 60일 데이터 수 : ${trend.length}개`);
    console.log(`- 최근 60일 최고가 (maxPrice): ${maxPrice.toLocaleString()}원 (날짜: ${maxDate})`);
    console.log(`- 최고가 시점 KRX 호가단위   : ${tick1Size}원 (가격 ${maxPrice}원 기준)`);
    console.log(`- 1호가 위 가격               : ${price1TickAbove.toLocaleString()}원`);
    console.log(`- **2호가 위 가격**               : **${price2TicksAbove.toLocaleString()}원**`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

calculateAltHighestAnd2TicksAbove();
