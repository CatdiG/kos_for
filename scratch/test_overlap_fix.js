async function test() {
  const urls = [
    'http://localhost:3000/api/stock/ranking?type=foreign&direction=buy&period=1d&mode=daily&limit=20&market=ALL',
    'http://localhost:3000/api/stock/ranking?type=organ&direction=buy&period=1d&mode=daily&limit=20&market=ALL',
    'http://localhost:3000/api/stock/ranking?type=overlap&direction=buy&period=1d&mode=daily&limit=20&market=ALL',
    'http://localhost:3000/api/stock/ranking?type=overlap&direction=sell&period=1d&mode=daily&limit=20&market=ALL'
  ];
  for (const url of urls) {
    const res = await fetch(url);
    const data = await res.json();
    console.log('\nURL:', url);
    console.log('Status:', res.status, 'List length:', data.list?.length, 'isMock:', data.isMock);
    if (data.list && data.list.length > 0) {
      console.log('Top 3:', data.list.slice(0, 3).map(i => `${i.rank}위 ${i.name}(${i.symbol}): ${i.netBuyAmtEok}억`));
    }
  }
}
test();
