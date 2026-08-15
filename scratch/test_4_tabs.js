async function test() {
  const tabs = [
    { type: 'foreign', direction: 'buy', name: '외국인 순매수' },
    { type: 'foreign', direction: 'sell', name: '외국인 순매도' },
    { type: 'organ', direction: 'buy', name: '기관 순매수' },
    { type: 'organ', direction: 'sell', name: '기관 순매도' },
  ];
  for (const t of tabs) {
    console.log(`\n=== Testing: ${t.name} ===`);
    try {
      const res = await fetch(`http://localhost:3000/api/stock/ranking?type=${t.type}&direction=${t.direction}&period=1d&mode=daily&limit=20&market=ALL`);
      const data = await res.json();
      console.log('isMock:', data.isMock);
      if (data.list && data.list.length > 0) {
        console.log('Top 5 Items:');
        data.list.slice(0, 5).forEach((item, idx) => {
          console.log(` ${idx+1}위: ${item.name} (${item.symbol}) | 현재가: ${item.currentPrice.toLocaleString()}원 | 수량: ${item.netBuyQty.toLocaleString()}주 | 대금: ${item.netBuyAmtEok}억원 (raw: ${item.netBuyAmt})`);
        });
      } else {
        console.log('No data or error:', data);
      }
    } catch (e) {
      console.error('Error fetching tab:', t.name, e);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}
test();
