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

async function verifyAltAndRanking() {
  console.log('\n====================================================================================================');
  console.log('1. DETAILED RAW INSPECTION FOR ALT (459550)');
  console.log('====================================================================================================');

  try {
    const altRes = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    console.log('ALT Stock Symbol:', altRes.stockInfo?.symbol);
    console.log('ALT Stock Name:', altRes.stockInfo?.name);
    console.log('ALT isMock Flag:', altRes.isMock);
    console.log('ALT Total Trend Days:', altRes.trend?.length);

    if (altRes.trend && altRes.trend.length > 0) {
      const prices = altRes.trend.map(d => d.closePrice);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      console.log(`ALT Price Range across 60D: Min ${minPrice.toLocaleString()}원 ~ Max ${maxPrice.toLocaleString()}원`);
      console.log(`Is ALT price in 2,500원 range? ${minPrice < 5000 && maxPrice < 5000}`);
      console.log(`Is ALT price in fake 60,000원~68,000원 range? ${minPrice > 50000 || maxPrice > 50000}`);

      console.log('\nFirst 5 items of ALT trend:');
      altRes.trend.slice(0, 5).forEach((d, i) => console.log(` [${i}] Date: ${d.date} | Close: ${d.closePrice} | High: ${d.highPrice} | Low: ${d.lowPrice}`));

      console.log('\nLast 5 items of ALT trend:');
      altRes.trend.slice(-5).forEach((d, i) => console.log(` [${i}] Date: ${d.date} | Close: ${d.closePrice} | High: ${d.highPrice} | Low: ${d.lowPrice}`));
    }
  } catch (err) {
    console.error('Error fetching ALT:', err.message);
  }

  console.log('\n====================================================================================================');
  console.log('2. 10 REAL RANKING STOCKS RAW VERIFICATION (INCLUDING ALT 459550)');
  console.log('====================================================================================================\n');

  const rankingRes = await fetchJson('http://localhost:3000/api/ranking/foreign?direction=buy&period=1d');
  const items = rankingRes.list || rankingRes.items || [];
  const targetSymbols = ['459550', '005930', '000660', '066570', '005380', '012450', '004370', '042660', '440110', '278470'];

  for (const sym of targetSymbols) {
    try {
      const res = await fetchJson(`http://localhost:3000/api/stock/investor-trend?symbol=${sym}&period=60d&_t=${Date.now()}`);
      const trend = res.trend || [];
      const isMock = res.isMock || false;
      const totalLen = trend.length;
      const prices = trend.map(d => d.closePrice);
      const minP = prices.length > 0 ? Math.min(...prices) : 0;
      const maxP = prices.length > 0 ? Math.max(...prices) : 0;

      // MA calculations for 60D slice
      const sliced60 = trend.slice(-60);
      let ma5Nulls = 0;
      let ma20Nulls = 0;
      let ma60Nulls = 0;

      sliced60.forEach((item, idx) => {
        const fullIdx = totalLen - sliced60.length + idx;
        const slice5 = trend.slice(Math.max(0, fullIdx - 4), fullIdx + 1);
        const slice20 = trend.slice(Math.max(0, fullIdx - 19), fullIdx + 1);
        const slice60 = trend.slice(Math.max(0, fullIdx - 59), fullIdx + 1);

        if (slice5.length === 0) ma5Nulls++;
        if (slice20.length === 0) ma20Nulls++;
        if (slice60.length === 0) ma60Nulls++;
      });

      const name = res.stockInfo?.name || sym;
      console.log(`[${sym}] ${name.padEnd(16, ' ')} | isMock: ${String(isMock).padEnd(5, ' ')} | History: ${String(totalLen).padStart(3, ' ')}d | Price Range: ${minP.toLocaleString()}원 ~ ${maxP.toLocaleString()}원 | MA Nulls: ${ma5Nulls}/${ma20Nulls}/${ma60Nulls}`);
    } catch (e) {
      console.error(`Error verifying ${sym}:`, e.message);
    }
  }

  console.log('\n====================================================================================================');
}

verifyAltAndRanking();
