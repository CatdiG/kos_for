const https = require('https');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', err => resolve({ status: 500, error: err.message, body: '' }));
  });
}

async function main() {
  const symbol = '459500';
  console.log(`Checking Naver stock price for code: ${symbol}`);

  // Test 1: fapi.naver.com
  const r1 = await fetchUrl(`https://fapi.naver.com/m/stock/domestic/stock/${symbol}/price/daily?page=1&pageSize=10`);
  console.log(`[1] fapi status: ${r1.status}`);
  if (r1.body) {
    try {
      const j1 = JSON.parse(r1.body);
      console.log(`[1] fapi response sample:`, Array.isArray(j1) ? j1.slice(0, 3) : j1);
    } catch(e) {
      console.log(`[1] fapi raw:`, r1.body.slice(0, 200));
    }
  }

  // Test 2: m.stock.naver.com price
  const r2 = await fetchUrl(`https://m.stock.naver.com/api/stock/${symbol}/price?count=10&type=day`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  console.log(`\n[2] m.stock status: ${r2.status}`);
  if (r2.body) {
    try {
      const j2 = JSON.parse(r2.body);
      console.log(`[2] m.stock response sample:`, Array.isArray(j2) ? j2.slice(0, 3) : j2);
    } catch(e) {
      console.log(`[2] m.stock raw:`, r2.body.slice(0, 200));
    }
  }

  // Test 3: Naver sise_day HTML parsing
  const r3 = await fetchUrl(`https://finance.naver.com/item/sise_day.naver?code=${symbol}&page=1`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  console.log(`\n[3] sise_day.naver status: ${r3.status}`);
  if (r3.body) {
    const lines = r3.body.split('\n');
    const dateLines = lines.filter(l => l.includes('span class="tah p10 gray03"'));
    console.log(`[3] Date matches count: ${dateLines.length}`);
    if (dateLines.length > 0) {
      console.log(`Sample date matches:`, dateLines.slice(0, 3).map(l => l.trim()));
    }
  }
}

main().catch(console.error);
