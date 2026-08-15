// Mock 30 days of trend data (what KIS API returns)
const trend30 = [];
let price = 1500000;
for (let i = 0; i < 30; i++) {
  price += Math.round((Math.sin(i * 0.4) * 15000));
  trend30.push({
    formattedDate: `08.${String(i + 1).padStart(2, '0')}`,
    closePrice: price,
  });
}

// Partial-window continuous MA calculation
const trendWithMA = trend30.map((item, idx, arr) => {
  const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
  const ma5 = Math.round(slice5.reduce((sum, d) => sum + d.closePrice, 0) / slice5.length);

  const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
  const ma20 = Math.round(slice20.reduce((sum, d) => sum + d.closePrice, 0) / slice20.length);

  const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
  const ma60 = Math.round(slice60.reduce((sum, d) => sum + d.closePrice, 0) / slice60.length);

  return {
    ...item,
    ma5,
    ma20,
    ma60,
  };
});

console.log('=== Partial-Window Continuous MA Calculation Verification ===');
console.log('Item 0 (Leftmost):');
console.log(`  Close: ${trendWithMA[0].closePrice.toLocaleString()}원`);
console.log(`  MA5  : ${trendWithMA[0].ma5.toLocaleString()} 원`);
console.log(`  MA20 : ${trendWithMA[0].ma20.toLocaleString()} 원`);
console.log(`  MA60 : ${trendWithMA[0].ma60.toLocaleString()} 원`);

console.log('\nItem 10 (Middle):');
console.log(`  Close: ${trendWithMA[10].closePrice.toLocaleString()}원`);
console.log(`  MA5  : ${trendWithMA[10].ma5.toLocaleString()} 원`);
console.log(`  MA20 : ${trendWithMA[10].ma20.toLocaleString()} 원`);
console.log(`  MA60 : ${trendWithMA[10].ma60.toLocaleString()} 원`);

console.log('\nItem 29 (Rightmost):');
console.log(`  Close: ${trendWithMA[29].closePrice.toLocaleString()}원`);
console.log(`  MA5  : ${trendWithMA[29].ma5.toLocaleString()} 원`);
console.log(`  MA20 : ${trendWithMA[29].ma20.toLocaleString()} 원`);
console.log(`  MA60 : ${trendWithMA[29].ma60.toLocaleString()} 원`);
