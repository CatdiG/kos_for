const http = require('http');

http.get('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=60d', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    const trend = json.trend || [];
    console.log('Total trend length:', trend.length);

    const sliced60 = trend.slice(-60);
    console.log(`60D Slice Length: ${sliced60.length}`);
    console.log(`60D Slice Start Date: ${sliced60[0].date}, Close: ${sliced60[0].closePrice}`);
    console.log(`60D Slice End Date: ${sliced60[sliced60.length - 1].date}, Close: ${sliced60[sliced60.length - 1].closePrice}`);

    // Check for duplicate flat price count in left half (first 30 items of 60D slice)
    const left30 = sliced60.slice(0, 30);
    const uniquePrices = new Set(left30.map(d => d.closePrice));
    console.log(`Left 30 items unique prices count: ${uniquePrices.size}`);
    console.log(`Unique prices in left 30:`, Array.from(uniquePrices));

    console.log('\n--- First 10 items of 60D view ---');
    left30.slice(0, 10).forEach((d, i) => {
      console.log(`[${i}] Date: ${d.date} | Close: ${d.closePrice} | High: ${d.highPrice} | Low: ${d.lowPrice}`);
    });
  });
});
