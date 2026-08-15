const http = require('http');

function checkSymbol(symbol, name) {
  return new Promise((resolve) => {
    http.get(`http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=60d`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log(`\n--- Symbol: ${symbol} (${name}) ---`);
          console.log('Period:', json.period);
          console.log('Trend total length:', json.trend?.length);
          if (json.trend && json.trend.length > 0) {
            console.log('First date:', json.trend[0].date, 'Close:', json.trend[0].closePrice);
            console.log('Last date:', json.trend[json.trend.length - 1].date, 'Close:', json.trend[json.trend.length - 1].closePrice);
          }
        } catch (e) {
          console.error(`Error for ${symbol}:`, e.message);
        }
        resolve();
      });
    });
  });
}

async function run() {
  await checkSymbol('196170', '알테오젠');
  await checkSymbol('005930', '삼성전자');
  await checkSymbol('459550', '알트');
}

run();
