const http = require('http');

function fetchLocalTrend(symbol, period) {
  return new Promise((resolve) => {
    const url = `http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=${period}&t=${Date.now()}`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({ error: e.message }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

function processTrendPipeline(rawTrend, period) {
  // 1. Raw Data Verification Logging
  console.log(`[Pipeline] Raw items count: ${rawTrend.length} (Min 60 required: ${rawTrend.length >= 60 ? 'PASS ✅' : 'FAIL ❌'})`);
  const recent5 = rawTrend.slice(-5);
  console.log(`[Pipeline] Recent 5 Days Data:`);
  recent5.forEach(d => {
    console.log(`  Date: ${d.formattedDate || d.date} | Close: ${d.closePrice.toLocaleString()}원`);
  });

  // 2 & 3. Full Array MA Calculation BEFORE slicing + Newly Listed Exception Guard (null if insufficient history)
  const fullTrendWithMA = rawTrend.map((item, idx, arr) => {
    const ma5 = idx >= 4 
      ? Math.round(arr.slice(idx - 4, idx + 1).reduce((sum, d) => sum + (d.closePrice || 0), 0) / 5) 
      : null;

    const ma20 = idx >= 19 
      ? Math.round(arr.slice(idx - 19, idx + 1).reduce((sum, d) => sum + (d.closePrice || 0), 0) / 20) 
      : null;

    const ma60 = idx >= 59 
      ? Math.round(arr.slice(idx - 59, idx + 1).reduce((sum, d) => sum + (d.closePrice || 0), 0) / 60) 
      : null;

    return {
      ...item,
      ma5,
      ma20,
      ma60,
    };
  });

  // 4. Viewport Slicing AFTER full MA computation
  const limit = period === '5d' ? 5 : period === '20d' ? 20 : 60;
  const sliced = fullTrendWithMA.slice(-limit);

  return { fullCount: rawTrend.length, slicedCount: sliced.length, sliced };
}

async function main() {
  const symbol = '459550'; // 알트 (Alt)
  console.log(`=== Testing Overhauled MA Pipeline for Alt (${symbol}) ===\n`);
  const data = await fetchLocalTrend(symbol, '60d');
  const rawTrend = data.trend || [];

  for (const period of ['5d', '20d', '60d']) {
    console.log(`\n--- Testing Period: ${period} ---`);
    const res = processTrendPipeline(rawTrend, period);
    const first = res.sliced[0];
    const last = res.sliced[res.sliced.length - 1];
    console.log(`Viewport (${period}) Range: ${first.formattedDate || first.date} ~ ${last.formattedDate || last.date}`);
    console.log(`  First candle (${first.formattedDate || first.date}): Close=${first.closePrice.toLocaleString()}원, MA5=${first.ma5?.toLocaleString() ?? 'null'}, MA20=${first.ma20?.toLocaleString() ?? 'null'}, MA60=${first.ma60?.toLocaleString() ?? 'null'}`);
    console.log(`  Last candle (${last.formattedDate || last.date}): Close=${last.closePrice.toLocaleString()}원, MA5=${last.ma5?.toLocaleString() ?? 'null'}, MA20=${last.ma20?.toLocaleString() ?? 'null'}, MA60=${last.ma60?.toLocaleString() ?? 'null'}`);
  }
}

main().catch(console.error);
