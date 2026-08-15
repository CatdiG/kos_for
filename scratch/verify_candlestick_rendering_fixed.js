function testCandlestickBarGuardCondition() {
  console.log('\n====================================================================================================');
  console.log('CandlestickBar minPrice === 0 가드 조건식 버그 수정 검증');
  console.log('====================================================================================================\n');

  const payload = { closePrice: 2775, openPrice: 2140 };

  // 1. Existing buggy condition: !minPrice
  const minPriceBuggy = 0;
  const maxPriceBuggy = 25000;
  const isBuggyNull = Boolean(!payload || !minPriceBuggy || !maxPriceBuggy || maxPriceBuggy <= minPriceBuggy);

  // 2. Fixed condition: minPrice === undefined
  const isFixedNull = Boolean(!payload || minPriceBuggy === undefined || maxPriceBuggy === undefined || maxPriceBuggy <= minPriceBuggy);

  console.log(`- minPrice = 0 일 때:`);
  console.log(`  1) 버그 있던 가드 조건 (!minPrice 사용)       : return ${isBuggyNull ? 'null (❌ 캔들 렌더링 파괴!)' : 'render'}`);
  console.log(`  2) 수정된 가드 조건 (minPrice === undefined) : return ${isFixedNull ? 'null' : 'render (✅ 캔들 정상 렌더링!)'}`);

  console.log('\n====================================================================================================\n');
}

testCandlestickBarGuardCondition();
