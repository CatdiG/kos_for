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

async function calculateExactAltMarginTicks() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) (최저가-2호가) ~ (최고가+2호가) 정밀 기준 계산');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = (res.trend || []).slice(-60);

    let minRaw = Infinity;
    let maxRaw = -Infinity;

    trend.forEach((d) => {
      const c = d.closePrice;
      if (!c || c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);

      minRaw = Math.min(minRaw, o, h, l, c);
      maxRaw = Math.max(maxRaw, o, h, l, c);
    });

    const minTick = getKrxTickSize(minRaw); // 1원
    const maxTick = getKrxTickSize(maxRaw); // 5원

    const rawMinBound = minRaw - 2 * minTick; // 990원
    const rawMaxBound = maxRaw + 2 * maxTick; // 2585원

    console.log(`- 알트 60일 실제 최저가 (minRaw) : ${minRaw}원 (호가단위 ${minTick}원)`);
    console.log(`- 알트 60일 실제 최고가 (maxRaw) : ${maxRaw}원 (호가단위 ${maxTick}원)`);
    console.log(`\n--- 1. 순수 (최저가-2호가) ~ (최고가+2호가) 경계값 ---`);
    console.log(` - 최하단 경계값 (최저가 - 2호가) : **${rawMinBound}원** (${minRaw} - 2*${minTick})`);
    console.log(` - 최상단 경계값 (최고가 + 2호가) : **${rawMaxBound}원** (${maxRaw} + 2*${maxTick})`);

    console.log(`\n--- 2. KRX 정수 눈금(250원 간격) 정렬 시 Y축 눈금 ---`);
    const startP = Math.floor(rawMinBound / 250) * 250; // 750원
    const endP = Math.ceil(rawMaxBound / 250) * 250;   // 2750원
    console.log(` - Y축 최하단 표시 눈금 : **${startP}원**`);
    console.log(` - Y축 최상단 표시 눈금 : **${endP}원**`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

calculateExactAltMarginTicks();
