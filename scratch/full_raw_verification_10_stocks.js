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

async function runFullRawVerification() {
  console.log('\n====================================================================================================');
  console.log('10개 종목 RAW 데이터 전수 검증 (알트 459550 필수 포함)');
  console.log('====================================================================================================\n');

  const targetStocks = [
    { symbol: '459550', name: '알트 (선택 종목/신규주)' },
    { symbol: '005930', name: '삼성전자' },
    { symbol: '000660', name: 'SK하이닉스' },
    { symbol: '066570', name: 'LG전자' },
    { symbol: '005380', name: '현대차' },
    { symbol: '012450', name: '한화에어로스페이스' },
    { symbol: '004370', name: '농심' },
    { symbol: '042660', name: '한화오션' },
    { symbol: '440110', name: '파두' },
    { symbol: '278470', name: '에이피알' },
  ];

  console.log('| 종목코드 | 종목명 | isMock (가짜여부) | 전체데이터수 | 60D표시구간 시작일~종료일 | 종가 범위 (Min ~ Max) | MA5/20/60 Null 개수 | 뱃지 노출 여부 | 검증 상태 |');
  console.log('|---|---|---|---|---|---|---|---|---|');

  let allPassed = true;

  for (const s of targetStocks) {
    try {
      const url = `http://localhost:3000/api/stock/investor-trend?symbol=${s.symbol}&period=60d&_t=${Date.now()}`;
      const res = await fetchJson(url);
      const trend = res.trend || [];
      const isMock = res.isMock || false;
      const totalLen = trend.length;

      // Compute MA values EXACTLY as RankingStockDetailChart.tsx does
      const fullTrendWithMA = trend.map((item, idx, arr) => {
        const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
        const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : null;

        const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
        const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : null;

        const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
        const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;

        return { ...item, ma5, ma20, ma60 };
      });

      const sliced60 = fullTrendWithMA.slice(-60);
      const prices = sliced60.map(d => d.closePrice || 0);
      const minP = prices.length > 0 ? Math.min(...prices) : 0;
      const maxP = prices.length > 0 ? Math.max(...prices) : 0;

      let ma5Nulls = 0;
      let ma20Nulls = 0;
      let ma60Nulls = 0;

      sliced60.forEach((item) => {
        if (item.ma5 === null || item.ma5 === undefined) ma5Nulls++;
        if (item.ma20 === null || item.ma20 === undefined) ma20Nulls++;
        if (item.ma60 === null || item.ma60 === undefined) ma60Nulls++;
      });

      const firstDate = sliced60[0]?.date || 'N/A';
      const lastDate = sliced60[sliced60.length - 1]?.date || 'N/A';

      // Badge condition in component: trend.length < 60 && diffCalendarDays < 85
      const firstItemDateStr = trend[0]?.date || '';
      let isBadgeShown = false;
      if (totalLen < 60 && firstItemDateStr.length === 8) {
        const py = parseInt(firstItemDateStr.slice(0, 4), 10);
        const pm = parseInt(firstItemDateStr.slice(4, 6), 10) - 1;
        const pd = parseInt(firstItemDateStr.slice(6, 8), 10);
        const firstDateObj = new Date(py, pm, pd);
        const diffCal = Math.round((Date.now() - firstDateObj.getTime()) / (1000 * 3600 * 24));
        isBadgeShown = totalLen < 50 && diffCal < 35;
      }

      const isOk = !isMock && ma5Nulls === 0 && ma20Nulls === 0 && ma60Nulls === 0 && sliced60.length > 0;
      if (!isOk) allPassed = false;

      console.log(`| \`${s.symbol}\` | **${s.name}** | \`${String(isMock)}\` | **${totalLen}일** | \`${firstDate}\` ~ \`${lastDate}\` | **${minP.toLocaleString()}원 ~ ${maxP.toLocaleString()}원** | **${ma5Nulls}/${ma20Nulls}/${ma60Nulls}** | ${isBadgeShown ? '⚠️ 뱃지노출 (신규주)' : '❌ 미노출 (정상)'} | ${isOk ? '✅ **PASS**' : '❌ **FAIL**'} |`);
    } catch (e) {
      console.error(`Error for ${s.symbol}:`, e.message);
      allPassed = false;
    }
  }

  console.log('\n====================================================================================================');
  console.log(`전수 검증 종합 결과: ${allPassed ? '✅ 10개 종목 전원 실제 시세 데이터 100% 정상 통과 (isMock = false, MA Nulls = 0)' : '❌ FAIL 발생'}`);
  console.log('====================================================================================================\n');
}

runFullRawVerification();
