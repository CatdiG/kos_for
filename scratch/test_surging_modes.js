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

async function testSurgingModes() {
  console.log('=== Testing Surging Stock API Outputs (Fluctuation / Volume / Amount / Overlap) ===\n');

  const [fluc, vol, amt, overlap] = await Promise.all([
    fetchJson('/api/stock/surging?mode=fluctuation&market=ALL'),
    fetchJson('/api/stock/surging?mode=volume&market=ALL'),
    fetchJson('/api/stock/surging?mode=amount&market=ALL'),
    fetchJson('/api/stock/surging?mode=overlap&market=ALL'),
  ]);

  console.log('--- 1. Fluctuation (등락률 상위) Top 10 ---');
  if (fluc && fluc.list) {
    fluc.list.slice(0, 10).forEach((i) => console.log(`  Rank ${i.rank} [${i.name} ${i.symbol}]: ChangeRate = +${i.changeRate}%`));
  }

  console.log('\n--- 2. Volume (거래량 상위) Top 10 ---');
  if (vol && vol.list) {
    vol.list.slice(0, 10).forEach((i) => console.log(`  Rank ${i.rank} [${i.name} ${i.symbol}]: ChangeRate = ${i.changeRate}%, Volume = ${i.volume.toLocaleString()}`));
  }

  console.log('\n--- 3. Amount (거래대금 상위) Top 10 ---');
  if (amt && amt.list) {
    amt.list.slice(0, 10).forEach((i) => console.log(`  Rank ${i.rank} [${i.name} ${i.symbol}]: ChangeRate = ${i.changeRate}%, AmountEok = ${i.amountEok}억`));
  }

  console.log('\n--- 4. Overlap (급등주 교집합 3중) Items ---');
  if (overlap && overlap.list) {
    console.log(`Total Overlap Items: ${overlap.list.length}`);
    overlap.list.forEach((i) => {
      console.log(`  [${i.name} ${i.symbol}]: ChangeRate = ${i.changeRate}%, Badge = ${i.surgingBadge}, Foreign = ${i.foreignSupplyBadge}, Organ = ${i.organSupplyBadge}`);
    });
  }
}

testSurgingModes().catch(console.error);
