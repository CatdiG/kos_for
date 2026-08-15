function testRechartsLogAlignment() {
  console.log('\n====================================================================================================');
  console.log('Y축 눈금 - 캔들스틱 - 이동평균선 위치 불일치 원인 정밀 검증');
  console.log('====================================================================================================\n');

  const minPrice = 1680;
  const maxPrice = 24500;
  const plotHeight = 170;
  const topPadding = 10;

  const samplePrice = 2775;

  // Linear Y position (YAxis tick position)
  const linearY = topPadding + (1 - (samplePrice - minPrice) / (maxPrice - minPrice)) * plotHeight;
  // Linear Y mapped price
  const linearPriceAtY = minPrice + (1 - (linearY - topPadding) / plotHeight) * (maxPrice - minPrice);

  // Log Y position (CandlestickBar position)
  const logMin = Math.log(minPrice);
  const logMax = Math.log(maxPrice);
  const logP = Math.log(samplePrice);
  const logY = topPadding + (1 - (logP - logMin) / (logMax - logMin)) * plotHeight;

  // On the linear Y-axis, what price does logY (148.16px) correspond to?
  const priceShownOnLinearAxisAtLogY = minPrice + (1 - (logY - topPadding) / plotHeight) * (maxPrice - minPrice);

  console.log(`- 실제 종가 데이터: ${samplePrice}원`);
  console.log(`- 캔들스틱 위치 (Log Y): y = ${logY.toFixed(2)} px`);
  console.log(`- Y축 눈금 위치 (Linear Y): y = ${linearY.toFixed(2)} px (위치 차이: Math.abs(${logY.toFixed(2)} - ${linearY.toFixed(2)}) = ${Math.abs(logY - linearY).toFixed(2)} px)`);
  console.log(`\n❌ [불일치 원인]: 캔들은 Log 좌표(y=${logY.toFixed(2)}px)에 그려졌지만, Y축 눈금과 이동평균선(Line)은 Linear 좌표(y=${linearY.toFixed(2)}px)를 가리킵니다.`);
  console.log(`   이로 인해 y=${logY.toFixed(2)}px 위치의 캔들을 Y축 눈금에서 읽으면 ${samplePrice}원이 아니라 약 ${Math.round(priceShownOnLinearAxisAtLogY)}원으로 잘못 읽히게 됩니다!`);

  console.log('\n====================================================================================================\n');
}

testRechartsLogAlignment();
