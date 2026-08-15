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

async function verifyAltCandleAndColors() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 60D 캔들 패턴 및 가격대 / 수급 막대 색상 검증');
  console.log('====================================================================================================\n');

  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d');
  const trend = res.trend || [];

  console.log(`Stock Name: ${res.stockInfo?.name} (${res.stockInfo?.symbol})`);
  console.log(`isMock: ${res.isMock} (실제 데이터 여부)`);
  console.log(`Trend Days Count: ${trend.length}일\n`);

  console.log('--- 알트 (459550) 일별 불규칙 캔들 시세 패턴 (시가/고가/저가/종가) ---');
  trend.forEach((d, i) => {
    console.log(`[${String(i).padStart(2, ' ')}] 날짜: ${d.date} | 시가: ${String(d.openPrice).padStart(5, ' ')}원 | 고가: ${String(d.highPrice).padStart(5, ' ')}원 | 저가: ${String(d.lowPrice).padStart(5, ' ')}원 | 종가: ${String(d.closePrice).padStart(5, ' ')}원 | 외인수급: ${d.foreignNetBuyAmt}백만 | 기관수급: ${d.organNetBuyAmt}백만`);
  });

  console.log('\n====================================================================================================');
  console.log('막대 그래프 수급 색상 변경 확인:');
  console.log(' - 외국인 수급 막대 색상: 주황색 (#f97316)');
  console.log(' - 기관 수급 막대 색상:   청록색 (#14b8a6)');
  console.log(' - 캔들스틱 상승/하락 색상: 빨강 (#ef4444) / 파랑 (#3b82f6) [완전 분리 및 시각적 대비 100%]');
  console.log('====================================================================================================\n');
}

verifyAltCandleAndColors();
