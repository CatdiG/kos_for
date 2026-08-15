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

const baseUrl = 'https://openapi.koreainvestment.com:9443';
const appKey = process.env.KIS_APPKEY;
const appSecret = process.env.KIS_APPSECRET;

async function run() {
  console.log('1. Getting Token...');
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  console.log('\n2. Testing program-trade-by-stock (FHPST01060000) for 005930...');
  const res = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/program-trade-by-stock?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930&FID_INPUT_HOUR_1=`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHPST01060000',
      custtype: 'P',
    },
  });
  console.log('program trade HTTP status:', res.status);
  const json = await res.json();
  console.log('program trade rt_cd:', json.rt_cd, 'msg1:', json.msg1, 'output2 length:', json.output2?.length);
}

run().catch((e) => console.error(e));
