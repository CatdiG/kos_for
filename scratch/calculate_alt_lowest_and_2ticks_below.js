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

async function calculateAltLowestAnd2TicksBelow() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 최근 60일 최저가 및 2호가 아래 가격 산출');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = (res.trend || []).slice(-60);

    let minPrice = Infinity;
    let minDate = '';

    trend.forEach((d) => {
      const c = d.closePrice || 0;
      if (c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);

      const dayMin = Math.min(o, h, l, c);
      if (dayMin < minPrice) {
        minPrice = dayMin;
        minDate = d.date;
      }
    });

    const tickSizeAtMin = getKrxTickSize(minPrice);
    
    // Calculate 2 ticks below minPrice
    // For price < 2000, 1 tick = 1원, so 2 ticks = 2원
    // For price 2000~5000, 1 tick = 5원, so 2 ticks = 10원
    const price1TickBelow = minPrice - tickSizeAtMin;
    const tickSize1Below = getKrxTickSize(price1TickBelow);
    const price2TicksBelow = price1TickBelow - tickSize1Below;

    console.log(`- 알트 최근 60일 데이터 수 : ${trend.length}개`);
    console.log(`- 최근 60일 최저가 (minPrice): ${minPrice.toLocaleString()}원 (날짜: ${minDate})`);
    console.log(`- 최저가 시점 KRX 호가단위   : ${tickSizeAtMin}원`);
    console.log(`- 1호가 아래 가격             : ${price1TickBelow.toLocaleString()}원`);
    console.log(`- **2호가 아래 가격**             : **${price2TicksBelow.toLocaleString()}원**`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

calculateAltLowestAnd2TicksBelow();
