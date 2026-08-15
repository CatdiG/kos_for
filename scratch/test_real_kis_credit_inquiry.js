const path = require('path');
const fs = require('fs');

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

const appKey = process.env.KIS_APPKEY;
const appSecret = process.env.KIS_APPSECRET;
const baseUrl = 'https://openapi.koreainvestment.com:9443';

async function run() {
  console.log('Obtaining access token...');
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret })
  });
  const tokenJson = await tokenRes.json();
  const token = tokenJson.access_token;
  console.log('Token successfully obtained!');

  const testSymbols = [
    { symbol: '005930', name: '삼성전자' },
    { symbol: '000660', name: 'SK하이닉스' },
    { symbol: '179900', name: '유티아이' },
    { symbol: '107600', name: '새빗켐' },
    { symbol: '082800', name: '제주반도체' },
  ];

  for (const item of testSymbols) {
    // KIS inquire-price TR: FHKST01010100
    const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${item.symbol}`;
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
    console.log(`\n=== Stock: ${item.name} (${item.symbol}) ===`);
    console.log('rt_cd:', json.rt_cd);
    if (json.rt_cd === '0' && json.output) {
      console.log('hts_kor_isnm (종목명):', json.output.hts_kor_isnm);
      console.log('stck_prpr (현재가):', json.output.stck_prpr);
      console.log('crdt_able_yn (신용가능여부 RAW):', json.output.crdt_able_yn);
      console.log('isCreditAvailable Evaluation:', json.output.crdt_able_yn === 'Y' ? 'true (신용가능)' : 'false (신용불가)');
    } else {
      console.log('Error message:', json.msg1);
    }

    // Delay 200ms to avoid TPS rate limit
    await new Promise(r => setTimeout(r, 200));
  }
}

run();
