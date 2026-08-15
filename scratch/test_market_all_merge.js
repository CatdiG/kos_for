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

async function testMarketMerge() {
  console.log('=== Comparing Market Filter Rankings (ALL vs KOSPI vs KOSDAQ) ===\n');

  const [allData, kospiData, kosdaqData] = await Promise.all([
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL'),
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=KOSPI'),
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=KOSDAQ'),
  ]);

  console.log('--- 1. Current "ALL" (전체) API Output Top 20 ---');
  if (allData && allData.list) {
    allData.list.slice(0, 20).forEach((item) => {
      // Determine market dynamically
      const marketName = item.market || (['440110', '257720', '466100', '058610', '241710'].includes(item.symbol) ? 'KOSDAQ' : 'KOSPI');
      console.log(`Rank ${String(item.rank).padStart(2, ' ')} [${marketName}] ${item.name} (${item.symbol}): NetBuyAmt = ${item.netBuyAmtEok}억원 (${item.netBuyAmt}백만원)`);
    });
  }

  console.log('\n--- 2. Direct "KOSPI" (코스피) API Output Top 5 ---');
  if (kospiData && kospiData.list) {
    kospiData.list.slice(0, 5).forEach((item) => {
      console.log(`Rank ${String(item.rank).padStart(2, ' ')} [KOSPI] ${item.name} (${item.symbol}): NetBuyAmt = ${item.netBuyAmtEok}억원`);
    });
  }

  console.log('\n--- 3. Direct "KOSDAQ" (코스닥) API Output Top 5 ---');
  if (kosdaqData && kosdaqData.list) {
    kosdaqData.list.slice(0, 5).forEach((item) => {
      console.log(`Rank ${String(item.rank).padStart(2, ' ')} [KOSDAQ] ${item.name} (${item.symbol}): NetBuyAmt = ${item.netBuyAmtEok}억원`);
    });
  }

  // Perform client-side manual merge of KOSPI + KOSDAQ top lists
  const mergedManual = [...(kospiData?.list || []), ...(kosdaqData?.list || [])];
  mergedManual.sort((a, b) => b.netBuyAmt - a.netBuyAmt);

  console.log('\n--- 4. Manually Merged & Sorted (KOSPI + KOSDAQ) Top 15 ---');
  mergedManual.slice(0, 15).forEach((item, idx) => {
    console.log(`Rank ${String(idx + 1).padStart(2, ' ')} [${item.market || 'Unknown'}] ${item.name} (${item.symbol}): NetBuyAmt = ${item.netBuyAmtEok}억원`);
  });
}

testMarketMerge().catch(console.error);
