// Mock 120 days of price trend data
const fullTrend = [];
let price = 1500000;
for (let i = 0; i < 120; i++) {
  price += Math.round((Math.sin(i * 0.4) * 20000));
  fullTrend.push({
    date: `20260${Math.floor(i/30)+1}${String(i%30+1).padStart(2,'0')}`,
    closePrice: price,
  });
}

// Compute MA5, MA20, MA60 on FULL dataset FIRST!
const fullTrendWithMA = fullTrend.map((item, idx, arr) => {
  // MA5: Requires at least 5 days
  const has5 = idx >= 4;
  const slice5 = has5 ? arr.slice(idx - 4, idx + 1) : [];
  const ma5 = has5 ? Math.round(slice5.reduce((sum, d) => sum + d.closePrice, 0) / 5) : null;

  // MA20: Requires at least 20 days
  const has20 = idx >= 19;
  const slice20 = has20 ? arr.slice(idx - 19, idx + 1) : [];
  const ma20 = has20 ? Math.round(slice20.reduce((sum, d) => sum + d.closePrice, 0) / 20) : null;

  // MA60: Requires at least 60 days
  const has60 = idx >= 59;
  const slice60 = has60 ? arr.slice(idx - 59, idx + 1) : [];
  const ma60 = has60 ? Math.round(slice60.reduce((sum, d) => sum + d.closePrice, 0) / 60) : null;

  return {
    ...item,
    ma5,
    ma20,
    ma60,
  };
});

// Now slice to selected period (e.g. 20d)
const period20d = fullTrendWithMA.slice(-20);

console.log('=== Pre-slicing Moving Average Calculation Verification (20d Period) ===');
console.log(`Total dataset days: ${fullTrendWithMA.length}, Sliced chart days: ${period20d.length}\n`);

console.log('Item 0 (Leftmost on chart):');
console.log(`  Date: ${period20d[0].date}, ClosePrice: ${period20d[0].closePrice.toLocaleString()}원`);
console.log(`  MA5 : ${period20d[0].ma5?.toLocaleString() || 'null'} 원 (Computed from 5 full historical days!)`);
console.log(`  MA20: ${period20d[0].ma20?.toLocaleString() || 'null'} 원 (Computed from 20 full historical days!)`);
console.log(`  MA60: ${period20d[0].ma60?.toLocaleString() || 'null'} 원 (Computed from 60 full historical days!)`);

console.log('\nItem 19 (Rightmost/Latest on chart):');
console.log(`  Date: ${period20d[19].date}, ClosePrice: ${period20d[19].closePrice.toLocaleString()}원`);
console.log(`  MA5 : ${period20d[19].ma5?.toLocaleString()} 원`);
console.log(`  MA20: ${period20d[19].ma20?.toLocaleString()} 원`);
console.log(`  MA60: ${period20d[19].ma60?.toLocaleString()} 원`);
