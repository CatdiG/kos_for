const http = require('http');

function fetchSurging(pathStr) {
  return new Promise((resolve) => {
    http.get(`http://localhost:3000${pathStr}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function runCheck() {
  console.log('=== Checking Surging Stocks API for Real Credit Status ===');
  const data = await fetchSurging('/api/stock/surging?mode=fluctuation&market=ALL');
  
  if (!data || !data.list) {
    console.log('Failed to load surging data.');
    return;
  }

  console.log(`Total surging items returned: ${data.list.length}`);
  
  const targets = ['001210', '131400', '125490', '269620'];
  targets.forEach((sym) => {
    const item = data.list.find((s) => s.symbol === sym);
    if (item) {
      console.log(`⭐ [${sym}] ${item.name}: isCreditAvailable = ${item.isCreditAvailable} (${item.isCreditAvailable ? '신용가능' : '신용불가 - 필터링됨!'})`);
    } else {
      console.log(`[${sym}] Not present in surging top list.`);
    }
  });

  const creditCount = data.list.filter(s => s.isCreditAvailable).length;
  const noCreditCount = data.list.filter(s => !s.isCreditAvailable).length;
  console.log(`\nSummary: Credit Available = ${creditCount}, Credit Unavailable = ${noCreditCount}`);

  console.log('\nTop 10 Credit Unavailable Stocks in Surging List:');
  data.list.filter(s => !s.isCreditAvailable).slice(0, 10).forEach(s => {
    console.log(`  Rank ${s.rank}: [${s.symbol}] ${s.name} | isCreditAvailable: ${s.isCreditAvailable}`);
  });
}

runCheck().catch(console.error);
