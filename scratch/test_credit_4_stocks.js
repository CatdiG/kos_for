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

async function inquirePrice(symbol) {
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

async function test4Stocks() {
  console.log('=== Step 2: Inquire Price crdt_able_yn for the 4 Specific Stocks ===');
  const targetSymbols = [
    { symbol: '001210', name: '금호전기' },
    { symbol: '131400', name: '이브이첨단소재' },
    { symbol: '125490', name: '한라캐스트' },
    { symbol: '269620', name: '시스웍' },
  ];

  for (const item of targetSymbols) {
    const output = await inquirePrice(item.symbol);
    console.log(`\n[${item.symbol}] ${item.name}:`);
    if (output) {
      console.log(`  crdt_able_yn: "${output.crdt_able_yn}"`);
      console.log(`  iscd_stat_cls_code: "${output.iscd_stat_cls_code}"`);
      console.log(`  mang_issu_cls_code: "${output.mang_issu_cls_code}"`);
      console.log(`  stck_prpr: "${output.stck_prpr}"`);
      console.log(`  prdy_ctrt: "${output.prdy_ctrt}%"`);
    } else {
      console.log('  Failed to retrieve output.');
    }
    await sleep(600);
  }
}

test4Stocks().catch(console.error);
