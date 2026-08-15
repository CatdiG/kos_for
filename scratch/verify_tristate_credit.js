const { mergeCreditStatusToRanking } = require('../src/lib/kisApi');

console.log('=== Tri-State Credit Status Verification & RAW Output Test ===\n');

// 1. Simulate 3 distinct stock items with Tri-State credit status
const mockItems = [
  { symbol: '005930', name: '삼성전자', isCreditAvailable: true },         // Case 1: Verified Eligible (Y)
  { symbol: '179900', name: '유티아이', isCreditAvailable: false },         // Case 2: Verified Restricted (N)
  { symbol: '099990', name: '테스트미확인종목', isCreditAvailable: undefined }  // Case 3: Failed Inquiry / EGW00201 Rate Limit (undefined)
];

console.log('1. Raw Input Items:');
mockItems.forEach(i => console.log(` - ${i.name} (${i.symbol}): isCreditAvailable = ${i.isCreditAvailable}`));

console.log('\n2. Filter Output when "신용가능" Filter is ON (creditOnly = true):');
const creditOnlyFiltered = mockItems.filter(i => i.isCreditAvailable === true);
console.log(' - Included items count:', creditOnlyFiltered.length);
creditOnlyFiltered.forEach(i => console.log(`   [ACCEPTED] ${i.name} (${i.symbol}) - Verified True Only`));

console.log('\n3. Rejected/Excluded items from "신용가능" Filter:');
const rejected = mockItems.filter(i => i.isCreditAvailable !== true);
rejected.forEach(i => console.log(`   [EXCLUDED] ${i.name} (${i.symbol}) - Reason: ${i.isCreditAvailable === false ? '신용불가 (N)' : '미확인/조회실패 (undefined)'}`));

console.log('\n4. Table UI Badge Status Assignment:');
mockItems.forEach(item => {
  let badgeText = '';
  if (item.isCreditAvailable === false) {
    badgeText = '[신용불가] (Red Badge)';
  } else if (item.isCreditAvailable === undefined) {
    badgeText = '[확인필요] (Gray Badge - Rate Limit/Failed)';
  } else {
    badgeText = '[신용가능] (Verified - Blue/No Badge)';
  }
  console.log(` - ${item.name} (${item.symbol}) => UI Display Badge: ${badgeText}`);
});
