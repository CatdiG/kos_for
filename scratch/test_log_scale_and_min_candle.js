function testLogScaleAndMinCandle() {
  console.log('\n====================================================================================================');
  console.log('네이버 증권 / 한투 HTS 방식: 로그 축 (Log Scale) 및 최소 캔들 두께 픽셀 비교');
  console.log('====================================================================================================\n');

  const minP = 1680;
  const maxP = 24500;
  const plotHeight = 170; // px

  // Linear scale priceToY
  const linearPriceToY = (p) => plotHeight * (1 - (p - minP) / (maxP - minP));

  // Log scale priceToY
  const logMin = Math.log(minP);
  const logMax = Math.log(maxP);
  const logPriceToY = (p) => plotHeight * (1 - (Math.log(p) - logMin) / (logMax - logMin));

  const augOpen = 2140;
  const augClose = 2775;

  const linearY1 = linearPriceToY(augOpen);
  const linearY2 = linearPriceToY(augClose);
  const linearBodyHeight = Math.abs(linearY2 - linearY1);

  const logY1 = logPriceToY(augOpen);
  const logY2 = logPriceToY(augClose);
  const logBodyHeight = Math.abs(logY2 - logY1);

  console.log('--- 8월 14일 캔들 (시가 2,140원 ~ 종가 2,775원) 픽셀 높이 비교 ---');
  console.log(`1) 선형 축 (Linear Scale - 현재 프로젝트)  : 캔들 몸통 높이 = ${linearBodyHeight.toFixed(2)} px (하단 5%에 바짝 찌그러짐)`);
  console.log(`2) 로그 축 (Log Scale - 네이버/HTS 표준 방식) : 캔들 몸통 높이 = ${logBodyHeight.toFixed(2)} px (${(logBodyHeight / linearBodyHeight).toFixed(1)}배 더 두껍고 선명하게 렌더링!)`);
  console.log(`   - 8월 14일 캔들 하단 위치: y = ${logY1.toFixed(2)} px (차트 전체 높이 170px 중 선명한 중앙 하단 지점!)`);

  console.log('\n====================================================================================================\n');
}

testLogScaleAndMinCandle();
