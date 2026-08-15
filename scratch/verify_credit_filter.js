const { getMockComprehensiveScoreRanking, getMockRankingData, TOP_50_STOCKS } = require('../src/lib/mockData');
const { mergeCreditStatusToRanking } = require('../src/lib/kisApi');

console.log('=== Verification of Credit Filter & Stock Inclusion ===\n');

// 1. Fetch ranking list from mock/data layer
const res = getMockComprehensiveScoreRanking('ALL');
console.log('Total Ranking Items generated:', res.list.length);

// 2. Apply mergeCreditStatusToRanking
const mergedList = mergeCreditStatusToRanking(res.list);

// 3. Filter credit-eligible stocks (isCreditAvailable !== false)
const creditEligible = mergedList.filter(item => item.isCreditAvailable !== false);
console.log('Credit Eligible Items count:', creditEligible.length);

// 4. Check specific major blue chips (삼성전자, SK하이닉스, 현대차, NAVER)
const targetSymbols = ['005930', '000660', '005380', '035420'];
console.log('\n--- Major Stocks Credit Status Check ---');
targetSymbols.forEach(sym => {
  const item = mergedList.find(i => i.symbol === sym);
  if (item) {
    console.log(`- ${item.name} (${item.symbol}): isCreditAvailable = ${item.isCreditAvailable} [${item.isCreditAvailable ? '가능' : '불가'}]`);
  } else {
    console.log(`- Symbol ${sym}: Not found in ranking list`);
  }
});
