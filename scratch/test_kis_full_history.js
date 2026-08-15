const http = require('http');

http.get('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=60d', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log('Symbol:', json.stockInfo?.symbol);
    console.log('Total items returned:', json.trend?.length);
    if (json.trend && json.trend.length > 0) {
      console.log('First 5 items:');
      json.trend.slice(0, 5).forEach((d, i) => console.log(` [${i}] Date: ${d.date}, Close: ${d.closePrice}`));
      console.log('Last 5 items:');
      json.trend.slice(-5).forEach((d, i) => console.log(` [${i}] Date: ${d.date}, Close: ${d.closePrice}`));
    }
  });
});
