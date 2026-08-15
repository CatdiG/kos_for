const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        process.env[k] = v;
      }
    }
  });
}

const appKey = process.env.KIS_APPKEY || '';
const appSecret = process.env.KIS_APPSECRET || '';
const isVirtual = process.env.KIS_VIRTUAL !== 'false';
const defaultBaseUrl = isVirtual 
  ? 'https://openapivts.koreainvestment.com:29443' 
  : 'https://openapi.koreainvestment.com:9443';
const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

async function getAccessToken() {
  if (!appKey || !appSecret) return null;
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    });
    const urlObj = new URL(`${baseUrl}/oauth2/tokenP`);
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.access_token || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function inquirePriceRaw(symbol) {
  const token = await getAccessToken();
  const pathStr = `/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(baseUrl).hostname,
      port: new URL(baseUrl).port,
      path: pathStr,
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHKST01010100',
        custtype: 'P',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.output);
        } catch(e) {
          resolve(null);
        }
      });
    });
    req.end();
  });
}

async function testNewStockCreditVerification() {
  console.log('=== Proof Test: Brand-New Un-cached Stocks Credit Resolution ===');
  
  // Pick 5 arbitrary newly introduced symbols from stock master that were not in the top 30 surging list
  const testNewSymbols = [
    { symbol: '006340', name: '대원전선' },
    { symbol: '145990', name: '삼양사' },
    { symbol: '018880', name: '한온시스템' },
    { symbol: '214390', name: '경보제약' },
    { symbol: '021880', name: '메이슨캐피탈' },
  ];

  console.log('Testing 5 brand-new un-cached symbols directly against KIS inquire-price API:');
  for (const item of testNewSymbols) {
    const rawOutput = await inquirePriceRaw(item.symbol);
    const crdtVal = rawOutput?.crdt_able_yn || 'N/A';
    const isCredit = crdtVal === 'Y';
    console.log(
      `  - Stock [${item.symbol}] ${item.name}: KIS Raw crdt_able_yn = "${crdtVal}" -> Evaluated isCreditAvailable = ${isCredit} (${isCredit ? '신용가능 (Y)' : '신용불가 (N)'})`
    );
    await sleep(400);
  }
}

testNewStockCreditVerification().catch(console.error);
