const http = require('http');

function fetchLocalTrend(symbol, period) {
  return new Promise((resolve) => {
    const url = `http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=${period}&t=${Date.now()}`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({ error: e.message }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

function calculateMA(trend) {
  return trend.map((item, idx, arr) => {
    const closePrice = item.closePrice || 0;
    const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
    const ma5 = Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / (slice5.length || 1));

    const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
    const ma20 = Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / (slice20.length || 1));

    const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
    const ma60 = Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / (slice60.length || 1));

    return {
      date: item.formattedDate || item.date,
      closePrice,
      ma5,
      ma20,
      ma60,
    };
  });
}

const symbols = [
  { code: '459550', name: '알트' },
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '005380', name: '현대차' },
  { code: '035420', name: 'NAVER' },
  { code: '035720', name: '카카오' },
];

async function main() {
  console.log(`=== ALL MAJOR STOCKS MOVING AVERAGE VERIFICATION ===\n`);
  for (const s of symbols) {
    const res = await fetchLocalTrend(s.code, '60d');
    const trend = res.trend || [];
    if (trend.length === 0) {
      console.log(`[${s.name} (${s.code})] Error fetching trend data`);
      continue;
    }
    const withMA = calculateMA(trend);
    const sliced20 = withMA.slice(-20);
    const first20 = sliced20[0];
    const last20 = sliced20[sliced20.length - 1];

    const ma5Dir = last20.ma5 > first20.ma5 ? '↗ 상향' : last20.ma5 < first20.ma5 ? '↘ 하향' : '➔ 보합';
    const ma20Dir = last20.ma20 > first20.ma20 ? '↗ 상향' : last20.ma20 < first20.ma20 ? '↘ 하향' : '➔ 보합';
    const ma60Dir = last20.ma60 > first20.ma60 ? '↗ 상향' : last20.ma60 < first20.ma60 ? '↘ 하향' : '➔ 보합';

    console.log(`[${s.name} (${s.code})] Total fetched items: ${trend.length}`);
    console.log(`  20일 뷰 영역: ${first20.date} ~ ${last20.date}`);
    console.log(`  종가 변화: ${first20.closePrice.toLocaleString()}원 -> ${last20.closePrice.toLocaleString()}원`);
    console.log(`  5일선 (MA5): ${first20.ma5.toLocaleString()}원 -> ${last20.ma5.toLocaleString()}원 (${ma5Dir})`);
    console.log(`  20일선 (MA20): ${first20.ma20.toLocaleString()}원 -> ${last20.ma20.toLocaleString()}원 (${ma20Dir})`);
    console.log(`  60일선 (MA60): ${first20.ma60.toLocaleString()}원 -> ${last20.ma60.toLocaleString()}원 (${ma60Dir})`);
    console.log('');
  }
}

main().catch(console.error);
