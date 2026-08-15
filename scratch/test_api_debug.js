const http = require('http');

http.get('http://localhost:3000/api/stock/investor-trend?symbol=006340', (res) => {
  let body = '';
  res.on('data', (c) => body += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const json = JSON.parse(body);
      console.log('StockInfo Name:', json.stockInfo?.name);
      console.log('StockInfo Symbol:', json.stockInfo?.symbol);
    } catch(e) {
      console.log('Body:', body.slice(0, 300));
    }
  });
});
