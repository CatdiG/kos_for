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

async function testSurgingOverlapLogic() {
  console.log('=== Testing Surging Overlap Logic ===');

  // Fetch all 3 surging lists from API
  const [flucData, volData, amtData, foreignData, organData] = await Promise.all([
    fetchJson('/api/stock/surging?mode=fluctuation&market=ALL'),
    fetchJson('/api/stock/surging?mode=volume&market=ALL'),
    fetchJson('/api/stock/surging?mode=amount&market=ALL'),
    fetchJson('/api/stock/ranking?type=foreign&direction=buy&period=1d&market=ALL'),
    fetchJson('/api/stock/ranking?type=organ&direction=buy&period=1d&market=ALL'),
  ]);

  const flucList = flucData?.list || [];
  const volList = volData?.list || [];
  const amtList = amtData?.list || [];

  console.log(`Fetched: Fluc=${flucList.length}, Vol=${volList.length}, Amt=${amtList.length}`);

  // Build Map of stock items
  const stockMap = new Map();

  // 1. Process Fluctuation List
  flucList.forEach((item) => {
    stockMap.set(item.symbol, {
      ...item,
      modes: ['fluctuation'],
      ranks: { fluctuation: item.rank },
    });
  });

  // 2. Process Volume List
  volList.forEach((item) => {
    if (stockMap.has(item.symbol)) {
      const existing = stockMap.get(item.symbol);
      existing.modes.push('volume');
      existing.ranks.volume = item.rank;
      if (!existing.volume || item.volume > existing.volume) existing.volume = item.volume;
    } else {
      stockMap.set(item.symbol, {
        ...item,
        modes: ['volume'],
        ranks: { volume: item.rank },
      });
    }
  });

  // 3. Process Amount List
  amtList.forEach((item) => {
    if (stockMap.has(item.symbol)) {
      const existing = stockMap.get(item.symbol);
      existing.modes.push('amount');
      existing.ranks.amount = item.rank;
      if (!existing.amountEok || item.amountEok > existing.amountEok) existing.amountEok = item.amountEok;
    } else {
      stockMap.set(item.symbol, {
        ...item,
        modes: ['amount'],
        ranks: { amount: item.rank },
      });
    }
  });

  // Build foreign & organ maps for quick lookup
  const foreignBuyMap = new Map((foreignData?.list || []).map((s) => [s.symbol, s]));
  const organBuyMap = new Map((organData?.list || []).map((s) => [s.symbol, s]));

  // Filter overlapping items (overlapCount >= 2)
  const overlappingItems = [];
  stockMap.forEach((entry) => {
    const overlapCount = entry.modes.length;
    if (overlapCount >= 2) {
      // Foreigner & Organ Supply Lookup
      const foreignItem = foreignBuyMap.get(entry.symbol);
      const organItem = organBuyMap.get(entry.symbol);

      overlappingItems.push({
        ...entry,
        overlapCount,
        modeLabels: entry.modes.map(m => m === 'fluctuation' ? '등락률' : m === 'volume' ? '거래량' : '거래대금'),
        foreignSupply: foreignItem
          ? { rank: foreignItem.rank, netBuyAmtEok: foreignItem.netBuyAmtEok }
          : null,
        organSupply: organItem
          ? { rank: organItem.rank, netBuyAmtEok: organItem.netBuyAmtEok }
          : null,
      });
    }
  });

  // Sort by overlapCount desc, then by changeRate desc
  overlappingItems.sort((a, b) => {
    if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
    return b.changeRate - a.changeRate;
  });

  console.log(`\nFound ${overlappingItems.length} Surging Overlap Items (2+ matches):`);
  overlappingItems.forEach((item, idx) => {
    console.log(
      `  ${idx + 1}. [${item.symbol}] ${item.name} | Match: ${item.overlapCount}개 (${item.modeLabels.join(' · ')}) | Change: +${item.changeRate}% | Amt: ${item.amountEok || 0}억 | Foreign: ${item.foreignSupply ? `${item.foreignSupply.rank}위 (+${item.foreignSupply.netBuyAmtEok}억)` : '랭킹 외'} | Organ: ${item.organSupply ? `${item.organSupply.rank}위 (+${item.organSupply.netBuyAmtEok}억)` : '랭킹 외'}`
    );
  });
}

testSurgingOverlapLogic().catch(console.error);
