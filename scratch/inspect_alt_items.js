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

async function inspectAltItems() {
  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
  const trend = res.trend || [];

  console.log('Total items:', trend.length);
  trend.forEach((d, i) => {
    console.log(`[${i}] date: ${d.date} | open: ${d.openPrice} | high: ${d.highPrice} | low: ${d.lowPrice} | close: ${d.closePrice} | ma5: ${d.ma5} | ma20: ${d.ma20} | ma60: ${d.ma60}`);
  });
}

inspectAltItems();
