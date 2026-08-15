const http = require('http');

http.get('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=20d', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log('Symbol:', json.stockInfo?.symbol);
    console.log('Total trend array length:', json.trend?.length);
    if (json.trend && json.trend.length > 0) {
      console.log('First date:', json.trend[0].date);
      console.log('Last date:', json.trend[json.trend.length - 1].date);
    }
  });
});
