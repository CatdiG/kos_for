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

async function runVerification() {
  console.log('Fetching active ranking stocks from /api/ranking/foreign?direction=buy&period=1d...');
  const rankingRes = await fetchJson('http://localhost:3000/api/ranking/foreign?direction=buy&period=1d');
  const items = rankingRes.list || rankingRes.items || [];
  console.log(`Total ranking items retrieved: ${items.length}`);

  if (items.length === 0) {
    console.error('No ranking items returned!', rankingRes);
    return;
  }

  // Pick 10 random stocks across top, middle, and bottom of ranking
  const sampleIndices = [0, 1, 3, 4, 5, 7, 9, 10, 13, 16];
  const sampleStocks = sampleIndices.map(i => ({
    symbol: items[i].symbol,
    name: items[i].name,
    rank: items[i].rank,
  }));

  console.log(`\nSelected 10 random ranking stocks for raw verification:`);
  sampleStocks.forEach(s => console.log(` - Rank #${s.rank}: [${s.symbol}] ${s.name}`));

  console.log('\n====================================================================================================');
  console.log('RAW VERIFICATION RESULT (60D MODE - MA5 / MA20 / MA60 CONTINUITY & NULL CHECK)');
  console.log('====================================================================================================\n');

  let allPassed = true;

  for (const s of sampleStocks) {
    try {
      const url = `http://localhost:3000/api/stock/investor-trend?symbol=${s.symbol}&period=60d&_t=${Date.now()}`;
      const res = await fetchJson(url);
      const trend = res.trend || [];

      // Compute MA values EXACTLY as RankingStockDetailChart.tsx does
      const fullTrendWithMA = trend.map((item, idx, arr) => {
        const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
        const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : null;

        const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
        const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : null;

        const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
        const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;

        return { ...item, ma5, ma20, ma60 };
      });

      const sliced60 = fullTrendWithMA.slice(-60);
      const totalLen = trend.length;

      // Count actual null values in display slice
      let ma5Nulls = 0;
      let ma20Nulls = 0;
      let ma60Nulls = 0;

      sliced60.forEach((item) => {
        if (item.ma5 === null || item.ma5 === undefined) ma5Nulls++;
        if (item.ma20 === null || item.ma20 === undefined) ma20Nulls++;
        if (item.ma60 === null || item.ma60 === undefined) ma60Nulls++;
      });

      const firstDate = sliced60[0]?.date || 'N/A';
      const lastDate = sliced60[sliced60.length - 1]?.date || 'N/A';
      const isShortBadgeShown = totalLen < 60;
      const isOk = ma5Nulls === 0 && ma20Nulls === 0 && ma60Nulls === 0 && sliced60.length === 60;

      if (!isOk) allPassed = false;

      console.log(`[Rank #${String(s.rank).padStart(2, ' ')}] [${s.symbol}] ${(s.name || '').padEnd(16, ' ')} | Total History: ${String(totalLen).padStart(3, ' ')}d | 60D Window: ${firstDate} ~ ${lastDate} | Nulls (MA5/20/60): ${ma5Nulls}/${ma20Nulls}/${ma60Nulls} | Short Badge: ${isShortBadgeShown ? 'YES' : 'NO (Clear)'} | Status: ${isOk ? '✅ PERFECT PASS' : '❌ FAIL'}`);
    } catch (err) {
      console.error(`Error verifying [${s.symbol}] ${s.name}:`, err.message);
      allPassed = false;
    }
  }

  console.log('\n====================================================================================================');
  console.log(`ALL 10 STOCKS VERIFICATION SUMMARY: ${allPassed ? '✅ 100% PERFECT PASS (ALL 10 STOCKS HAVE 0 NULLS ON MA LINES)' : '❌ FAIL DETECTED'}`);
  console.log('====================================================================================================\n');
}

runVerification();
