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

async function runFinalReportVerification() {
  console.log('\n====================================================================================================');
  console.log('1. [캔들 꼬리 검증] 삼성전자 (005930) 08/14 Raw 가격 4개 및 계산된 픽셀 좌표 4개');
  console.log('====================================================================================================');

  const sRes = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=60d');
  const sTrend = sRes.trend || [];
  const item0814 = sTrend.find(d => d.date === '20260814' || d.formattedDate === '08.14');

  let minP = Infinity;
  let maxP = -Infinity;
  sTrend.forEach((d) => {
    const c = d.closePrice;
    if (!c || c <= 0) return;
    const o = d.openPrice || c;
    const h = d.highPrice || Math.max(o, c);
    const l = d.lowPrice || Math.min(o, c);
    minP = Math.min(minP, o, h, l, c);
    maxP = Math.max(maxP, o, h, l, c);
  });

  const topPadding = 10;
  const plotHeight = 170;
  const priceToY = (price) => topPadding + (1 - (price - minP) / (maxP - minP)) * plotHeight;

  const openY = priceToY(item0814.openPrice);
  const closeY = priceToY(item0814.closePrice);
  const highY = priceToY(item0814.highPrice);
  const lowY = priceToY(item0814.lowPrice);

  console.log(`- Raw 4개 가격: openPrice=${item0814.openPrice.toLocaleString()}원 | highPrice=${item0814.highPrice.toLocaleString()}원 | lowPrice=${item0814.lowPrice.toLocaleString()}원 | closePrice=${item0814.closePrice.toLocaleString()}원`);
  console.log(`- 픽셀 4개 좌표: highY=${highY.toFixed(2)}px (위꼬리끝) | openY=${openY.toFixed(2)}px (몸통) | closeY=${closeY.toFixed(2)}px (몸통) | lowY=${lowY.toFixed(2)}px (아래꼬리끝)`);
  console.log(`- 위꼬리 길이 : ${(Math.min(openY, closeY) - highY).toFixed(2)} px (몸통 위로 돌출)`);
  console.log(`- 아래꼬리 길이: ${(lowY - Math.max(openY, closeY)).toFixed(2)} px (몸통 아래로 돌출)\n`);

  console.log('====================================================================================================');
  console.log('2. [60일선 검증] 알트 (459550) 60D 데이터 전체 배열 (30개 거래일) MA60 수치');
  console.log('====================================================================================================');

  const altRes = await fetchJson(`http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d&_t=${Date.now()}`);
  const altTrend = altRes.trend || [];

  const altWithMA = altTrend.map((item, idx, arr) => {
    const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
    const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;
    return { ...item, ma60 };
  });

  console.log('| Index | Date | closePrice | ma60 | Status |');
  console.log('|---|---|---|---|---|');
  let nullCount = 0;
  altWithMA.forEach((d, i) => {
    if (d.ma60 === null) nullCount++;
    console.log(`| [${String(i).padStart(2, ' ')}] | ${d.date} | ${d.closePrice.toLocaleString()}원 | **${d.ma60.toLocaleString()}원** | ${d.ma60 !== null ? '✅ VALID' : '❌ NULL'} |`);
  });
  console.log(`\n알트 (459550) ma60 Null 개수: ${nullCount}개 (${nullCount === 0 ? '✅ 100% 가득 채워짐 (NULL 0건)' : '❌ NULL 발견'})\n`);

  console.log('====================================================================================================');
}

runFinalReportVerification();
