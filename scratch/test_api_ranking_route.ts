async function testApiRoute() {
  console.log('Fetching http://localhost:3000/api/stock/ranking?type=foreign&direction=buy&period=1d&mode=daily&limit=20&market=KOSDAQ ...');
  const start = Date.now();
  const res = await fetch('http://localhost:3000/api/stock/ranking?type=foreign&direction=buy&period=1d&mode=daily&limit=20&market=KOSDAQ');
  console.log('Status:', res.status, 'Time:', Date.now() - start, 'ms');
  const json = await res.json();
  console.log('isMock:', json.isMock, 'mockReason:', json.mockReason);
  console.log('List length:', json.list ? json.list.length : 0);
  if (json.list) {
    json.list.forEach((item: any, idx: number) => {
      console.log(`${idx + 1}위: ${item.name} (${item.symbol}) | 현재가: ${item.currentPrice.toLocaleString()}원 | 수량: ${item.netBuyQty?.toLocaleString()}주 | 순매수대금: ${item.netBuyAmt}백만원 (${item.netBuyAmtEok}억원)`);
    });
  }
}

testApiRoute();
