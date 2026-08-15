const path = require('path');
const fs = require('fs');
const { fetchKisCreditAvailable } = require('../src/lib/kisApi');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1).trim();
      process.env[key] = val;
    }
  });
}

async function run() {
  console.log('=== Live KIS API Rate Limit Backoff & Credit Status Verification ===\n');

  const symbols = [
    { symbol: '005930', name: '삼성전자' },
    { symbol: '107600', name: '새빗켐' },
    { symbol: '179900', name: '유티아이' },
    { symbol: '000660', name: 'SK하이닉스' }
  ];

  for (const s of symbols) {
    console.log(`Querying ${s.name} (${s.symbol})...`);
    const status = await fetchKisCreditAvailable(s.symbol);
    let evaluationLabel = '확인필요/조회실패 (undefined)';
    if (status === true) evaluationLabel = '신용가능 (true)';
    if (status === false) evaluationLabel = '신용불가 (false)';

    console.log(` => Result for ${s.name} (${s.symbol}): status = ${status} [${evaluationLabel}]`);
  }
}

run();
