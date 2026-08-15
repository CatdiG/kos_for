const http = require('http');

function testEndpoint(pathStr, label) {
  return new Promise((resolve) => {
    http.get(`http://localhost:3000${pathStr}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        console.log(`\n=== Testing ${label} (${pathStr}) ===`);
        console.log(`HTTP Status: ${res.statusCode}`);
        try {
          const json = JSON.parse(body);
          console.log(`Mode: ${json.type}, Items Count: ${json.list?.length || 0}`);
          if (json.list && json.list.length > 0) {
            console.log('Top 12 Items (Sorted by Change Rate Descending):');
            json.list.slice(0, 12).forEach((item) => {
              console.log(
                `  Rank ${item.rank}: [${item.symbol}] ${item.name} | Price: ${item.currentPrice.toLocaleString()}원 | ChangeRate: +${item.changeRate.toFixed(2)}% | Vol: ${item.volume.toLocaleString()}주 | Amount: ${item.amountEok || 0}억원`
              );
            });
          }
        } catch(e) {
          console.log('Raw output:', body.slice(0, 300));
        }
        resolve();
      });
    }).on('error', (e) => {
      console.error(`Error testing ${label}:`, e.message);
      resolve();
    });
  });
}

async function runVerification() {
  console.log('--- Real-time Surging Stocks API Verification (Top 12) ---');
  await testEndpoint('/api/stock/surging?mode=fluctuation&market=ALL', '등락률 상위 (급등 순)');
}

runVerification().catch(console.error);
