const path = require('path');
const fs = require('fs');

// Load environment variables from .env.local if exists
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      process.env[key.trim()] = value.trim();
    }
  });
}

const appKey = process.env.KIS_APPKEY;
const appSecret = process.env.KIS_APPSECRET;

console.log('AppKey present:', !!appKey);
console.log('AppSecret present:', !!appSecret);

async function testFetchCredit(symbol) {
  if (!appKey || !appSecret) {
    console.log('No KIS API key available in env, checking offline test capability');
    return;
  }

  const isVirtual = process.env.KIS_VIRTUAL !== 'false';
  const defaultBaseUrl = isVirtual 
    ? 'https://openapivts.koreainvestment.com:29443' 
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  // Get token
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret
    })
  });
  const tokenJson = await tokenRes.json();
  const token = tokenJson.access_token;

  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    }
  });

  const json = await res.json();
  console.log(`\n=== Symbol: ${symbol} ===`);
  console.log('rt_cd:', json.rt_cd);
  console.log('msg1:', json.msg1);
  if (json.output) {
    console.log('stck_shrn_iscd:', json.output.stck_shrn_iscd);
    console.log('hts_kor_isnm:', json.output.hts_kor_isnm);
    console.log('crdt_able_yn (Raw Field):', json.output.crdt_able_yn);
    console.log('Interpretation:', json.output.crdt_able_yn === 'Y' ? '신용가능 (true)' : '신용불가 (false)');
  }
}

async function run() {
  const symbols = ['005930', '179900', '019540', '082800'];
  for (const sym of symbols) {
    await testFetchCredit(sym);
  }
}

run();
