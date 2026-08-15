const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      process.env[key] = val;
    }
  });
}

const { getKisAccessToken } = require('../src/lib/kisApi');

async function testReuse() {
  console.log('--- Calling getKisAccessToken Call #1 ---');
  const t1 = await getKisAccessToken();
  console.log('Token 1:', t1 ? t1.slice(0, 15) + '...' : 'NULL');

  console.log('--- Calling getKisAccessToken Call #2 ---');
  const t2 = await getKisAccessToken();
  console.log('Token 2:', t2 ? t2.slice(0, 15) + '...' : 'NULL');

  console.log('--- Calling getKisAccessToken Call #3 ---');
  const t3 = await getKisAccessToken();
  console.log('Token 3:', t3 ? t3.slice(0, 15) + '...' : 'NULL');
}

testReuse().catch(console.error);
