async function test3dOverlapMarket() {
  console.log('=== 3일연속 교집합 코스피 vs 코스닥 분리 검증 ===\n');

  for (const market of ['ALL', 'KOSPI', 'KOSDAQ']) {
    const url = `http://localhost:3000/api/ranking/overlap?mode=consecutive3d&market=${market}&limit=10`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const list = data.list || [];
      console.log(`📌 Market: ${market} -> 수신 종목 수: ${list.length}개`);
      list.forEach((item) => {
        console.log(`  - [${item.symbol}] ${item.name} (${item.investorBadge})`);
      });
      console.log('');
    } else {
      console.error(`Market ${market} error ${res.status}`);
    }
  }
}
test3dOverlapMarket();
