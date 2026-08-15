const http = require('http');
const https = require('https');

function fetchHttp(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: e.message, raw: data }); }
      });
    }).on('error', err => resolve({ error: err.message }));
  });
}

function fetchHttps(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: e.message, raw: data }); }
      });
    }).on('error', err => resolve({ error: err.message }));
  });
}

async function main() {
  const symbol = '459500'; // 알트 (Alt)
  console.log(`====================================================`);
  console.log(`[1] Querying Local Dev Server (/api/stock/investor-trend)`);
  console.log(`====================================================`);
  const localRes = await fetchHttp(`http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d&t=${Date.now()}`);

  if (localRes.trend && localRes.trend.length > 0) {
    console.log(`Local Trend Total Count: ${localRes.trend.length}`);
    console.log(`Latest 5 Days from Local Server Chart Data:`);
    localRes.trend.slice(-5).forEach(item => {
      console.log(`Date: ${item.formattedDate} (${item.date}) | Open: ${item.openPrice} | High: ${item.highPrice} | Low: ${item.lowPrice} | Close: ${item.closePrice} | PriceChange: ${item.priceChange} | Vol: ${item.volume}`);
    });
  } else {
    console.log(`Local Server Response:`, localRes);
  }

  console.log(`\n====================================================`);
  console.log(`[2] Querying Naver Finance Mobile API for Real Stock Data (459500 알트)`);
  console.log(`====================================================`);
  const naverRes = await fetchHttps(`https://m.stock.naver.com/api/stock/${symbol}/price?pageSize=10&page=1`);
  if (Array.isArray(naverRes)) {
    console.log(`Latest 5 Days Real OHLC from Naver (Official Market Data):`);
    naverRes.slice(0, 5).forEach(item => {
      console.log(`Date: ${item.localTradedAt} | Open: ${item.openPrice} | High: ${item.highPrice} | Low: ${item.lowPrice} | Close: ${item.closePrice} | Vol: ${item.accumulatedTradingVolume}`);
    });
  } else {
    console.log(`Naver Response:`, naverRes);
  }
}

main().catch(console.error);
