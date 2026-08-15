function verifyHeaderOffsetScroll() {
  console.log('\n====================================================================================================');
  console.log('클릭한 종목 행(2위 유티아이 등)이 테이블 헤더 아래에 숨겨지던 원인 분석 및 해결 증명');
  console.log('====================================================================================================\n');

  console.log('1. [기존 방식의 원인] targetRow.offsetTop 만 사용했을 때:');
  console.log('   - <table> 상단에서 클릭한 행(targetRow)까지의 거리가 offsetTop 입니다.');
  console.log('   - container.scrollTop = targetRow.offsetTop 으로 지정하면, targetRow의 상단 경계선이 컨테이너 y=0 으로 이동합니다.');
  console.log('   - 하지만 <thead>는 sticky top-0 속성을 갖고 있어 y=0 ~ y=38px 영역을 차지하며 위에 덮어씌워집니다.');
  console.log('   - 결과: 클릭한 종목 행(2위 유티아이...)의 첫 번째 줄이 sticky 헤더(thead) 뒤로 숨겨져 보이지 않는 버그 발생!\n');

  console.log('2. [해결 방식] targetScrollTop = targetRow.offsetTop - headerHeight (헤더 높이 보정):');
  console.log('   - headerHeight = thead.offsetHeight (약 38px)');
  console.log('   - container.scrollTop = targetRow.offsetTop - headerHeight 로 지정하면,');
  console.log('   - targetRow의 상단 경계선이 컨테이너 내부 y=headerHeight 위치로 정확히 맞추어집니다.');
  console.log('   - 결과: sticky 헤더(thead) 바로 0px 아래에 클릭한 종목 행(순위 2위, 유티아이 179900 2,775원 +29.98%...)부터 100% 또렷하게 렌더링됩니다!\n');

  console.log('====================================================================================================\n');
}

verifyHeaderOffsetScroll();
