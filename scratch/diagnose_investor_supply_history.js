const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function diagnoseInvestorSupplyHistory() {
  console.log('\n====================================================================================================');
  console.log('KIS API 4대 주체(외국인/기관/연기금/프로그램) 일별 수급 제공 일수 진단');
  console.log('====================================================================================================\n');

  try {
    const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
    const trend = res.trend || [];

    console.log(`- 전체 캔들 (일별 시세) 데이터 개수 : ${trend.length}개`);

    let validSupplyDaysCount = 0;
    let missingSupplyDaysCount = 0;

    console.log('\n--- 60D 뷰포트 내 캔들별 투자자 수급(외국인/기관/연기금) 데이터 유무 점검 ---');
    trend.slice(-60).forEach((d) => {
      const hasSupply = d.foreignNetBuyAmt !== 0 || d.organNetBuyAmt !== 0 || d.pensionNetBuyAmt !== 0;
      if (hasSupply) {
        validSupplyDaysCount++;
      } else {
        missingSupplyDaysCount++;
      }
    });

    console.log(`- 최근 60일 중 투자자 수급 데이터 존재하는 날짜 : ${validSupplyDaysCount}일 (최근 ~30일치만 제공됨)`);
    console.log(`- 최근 60일 중 투자자 수급 데이터 0원(미제공) 날짜: ${missingSupplyDaysCount}일 (30일 이전 과거 날짜)`);

    console.log('\n--- 30일 이전 과거 날짜 (예: 2026.05.20) 수급 수치 샘플 ---');
    const oldDay = trend[Math.max(0, trend.length - 60)];
    console.log(`- Date: ${oldDay.date} | 종가: ${oldDay.closePrice}원 | 외국인: ${oldDay.foreignNetBuyAmt}원 | 기관: ${oldDay.organNetBuyAmt}원 | 연기금: ${oldDay.pensionNetBuyAmt}원`);

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

diagnoseInvestorSupplyHistory();
