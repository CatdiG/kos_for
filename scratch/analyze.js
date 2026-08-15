const http = require('http');

function fetchTrend(symbol) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d`, (res) => {
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

async function analyzeStocks() {
  const symbols = ['005930', '000660', '373220', '005380', '012450', '068270', '005935'];
  for (const sym of symbols) {
    try {
      const res = await fetchTrend(sym);
      const trend = res.trend || [];
      if (trend.length === 0) {
        console.log(`\n=== Symbol: ${sym} (${res.stockInfo?.name || 'Unknown'}) === NO DATA`);
        continue;
      }

      console.log(`\n=== Symbol: ${sym} (${res.stockInfo?.name || 'Unknown'}) Total items: ${trend.length} ===`);
      console.log(`Date range: ${trend[0].date} ~ ${trend[trend.length - 1].date}`);

      // Check if dates are sorted ascending
      let isAscending = true;
      for (let i = 1; i < trend.length; i++) {
        if (trend[i].date < trend[i - 1].date) {
          isAscending = false;
          break;
        }
      }
      console.log(`Is Date Ascending? ${isAscending}`);

      // Calculate MA5
      const full = trend.map((item, idx, arr) => {
        const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
        const ma5 = idx >= 4 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / 5) : null;
        const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
        const ma20 = idx >= 19 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / 20) : null;
        return { date: item.date, close: item.closePrice, ma5, ma20 };
      });

      const sliced20 = full.slice(-20);
      console.log('Last 5 days of 20d slice:');
      sliced20.slice(-5).forEach(d => {
        console.log(`  Date: ${d.date} | Close: ${d.close} | MA5: ${d.ma5} | MA20: ${d.ma20}`);
      });

      // Price direction in last 5 days
      const firstClose = sliced20[sliced20.length - 5].close;
      const lastClose = sliced20[sliced20.length - 1].close;
      const priceDir = lastClose > firstClose ? 'RISING (상승)' : lastClose < firstClose ? 'FALLING (하락)' : 'FLAT (보합)';

      // MA5 direction in last 5 days
      const firstMA5 = sliced20[sliced20.length - 5].ma5;
      const lastMA5 = sliced20[sliced20.length - 1].ma5;
      const ma5Dir = (firstMA5 && lastMA5) ? (lastMA5 > firstMA5 ? 'RISING (상승)' : lastMA5 < firstMA5 ? 'FALLING (하락)' : 'FLAT (보합)') : 'N/A';

      console.log(`  => 5-Day Price Trend: ${priceDir} (${firstClose} -> ${lastClose})`);
      console.log(`  => 5-Day MA5 Trend: ${ma5Dir} (${firstMA5} -> ${lastMA5})`);
    } catch (e) {
      console.error(`Error analyzing ${sym}:`, e.message);
    }
  }
}

analyzeStocks();
