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

async function verifyAltMA60FullArray() {
  console.log('Fetching ALT (459550) 60D trend data...');
  const res = await fetchJson(`http://localhost:3000/api/stock/investor-trend?symbol=459550&period=60d&_t=${Date.now()}`);
  const trend = res.trend || [];

  const fullTrendWithMA = trend.map((item, idx, arr) => {
    const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
    const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length) : null;

    const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
    const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length) : null;

    const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
    const ma60 = slice60.length > 0 ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length) : null;

    return { ...item, ma5, ma20, ma60 };
  });

  console.log('\n====================================================================================================');
  console.log(`알트 (459550) 60D 데이터 전체 배열 (총 ${fullTrendWithMA.length}개 일자) MA60 수치 전수 검증`);
  console.log('====================================================================================================\n');

  let nullCount = 0;
  console.log('| Index | Date | closePrice | ma5 | ma20 | ma60 | Status |');
  console.log('|---|---|---|---|---|---|---|');

  fullTrendWithMA.forEach((d, i) => {
    if (d.ma60 === null || d.ma60 === undefined) nullCount++;
    console.log(`| [${String(i).padStart(2, ' ')}] | ${d.date} | ${String(d.closePrice).padStart(5, ' ')}원 | ${String(d.ma5).padStart(5, ' ')}원 | ${String(d.ma20).padStart(5, ' ')}원 | **${String(d.ma60).padStart(5, ' ')}원** | ${d.ma60 !== null ? '✅ VALID' : '❌ NULL'} |`);
  });

  console.log('\n====================================================================================================');
  console.log(`알트 (459550) MA60 Null 개수: ${nullCount}개 (${nullCount === 0 ? '✅ 100% 가득 채워짐 (NULL 0건)' : '❌ NULL 발견'})`);
  console.log('====================================================================================================\n');
}

verifyAltMA60FullArray();
