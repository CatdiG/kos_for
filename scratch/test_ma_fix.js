const http = require('http');

http.get('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=20d', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    const trend = json.trend || [];
    console.log('Total trend items:', trend.length);

    // Compute MA with fallback for short history
    const fullTrendWithMA = trend.map((item, idx, arr) => {
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length);

      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length);

      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length);

      return { date: item.date, close: item.closePrice, ma5, ma20, ma60 };
    });

    const sliced20 = fullTrendWithMA.slice(-20);
    console.log('\n--- 20D View MA Values (All 20 Days) ---');
    let nullMA5Count = 0, nullMA20Count = 0, nullMA60Count = 0;
    sliced20.forEach((d, idx) => {
      if (d.ma5 === null) nullMA5Count++;
      if (d.ma20 === null) nullMA20Count++;
      if (d.ma60 === null) nullMA60Count++;
      console.log(`[${idx}] Date: ${d.date} | Close: ${d.close} | MA5: ${d.ma5} | MA20: ${d.ma20} | MA60: ${d.ma60}`);
    });

    console.log(`\nNull Counts in 20D View: MA5=${nullMA5Count}, MA20=${nullMA20Count}, MA60=${nullMA60Count}`);
  });
});
