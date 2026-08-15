const http = require('http');

function fetchJson(pathStr) {
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

async function verifySurgingOverlapApi() {
  console.log('=== Verifying Live /api/stock/surging?mode=overlap API ===');
  const data = await fetchJson('/api/stock/surging?mode=overlap&market=ALL');

  if (!data || !data.list) {
    console.log('Failed to fetch surging overlap data.');
    return;
  }

  console.log(`Received ${data.list.length} Surging Overlap Items.`);

  data.list.forEach((item, idx) => {
    console.log(
      `Rank ${idx + 1}: [${item.symbol}] ${item.name} | Price: ${item.currentPrice} | Change: +${item.changeRate}% | Amt: ${item.amountEok || 0}억 | Badge: "${item.surgingBadge}" | Foreign: "${item.foreignSupplyBadge}" (dir: ${item.foreignSupplyDirection}) | Organ: "${item.organSupplyBadge}" (dir: ${item.organSupplyDirection})`
    );
  });
}

verifySurgingOverlapApi().catch(console.error);
