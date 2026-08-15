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

async function testApi(trId, pathStr) {
  const token = await getAccessToken();
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
        tr_id: trId,
        custtype: 'P',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, json });
        } catch(e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.end();
  });
}

async function runDetailedShdTests() {
  console.log('=== Detailed SHD (001770) Investigation ===');

  // Test 1: KOSPI Market Only (FID_INPUT_ISCD=0001)
  console.log('\n--- Test 1: KOSPI Market Only (FID_INPUT_ISCD=0001) ---');
  const pKospi = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0001&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
  const resKospi = await testApi('FHPST01700000', pKospi);
  const listKospi = resKospi.json?.output || [];
  console.log(`KOSPI returned ${listKospi.length} items.`);
  listKospi.forEach((s, idx) => {
    console.log(`  ${idx+1}. [${s.stck_shrn_iscd || s.mksc_shrn_iscd}] ${s.hts_kor_isnm}: rate=${s.prdy_ctrt}%, price=${s.stck_prpr}`);
  });
  const shdKospi = listKospi.find(s => (s.stck_shrn_iscd || s.mksc_shrn_iscd) === '001770' || (s.hts_kor_isnm && s.hts_kor_isnm.includes('SHD')));
  console.log('SHD in KOSPI list:', shdKospi || 'NOT FOUND');

  await sleep(1500);

  // Test 2: KOSDAQ Market Only (FID_INPUT_ISCD=1001)
  console.log('\n--- Test 2: KOSDAQ Market Only (FID_INPUT_ISCD=1001) ---');
  const pKosdaq = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=1001&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
  const resKosdaq = await testApi('FHPST01700000', pKosdaq);
  const listKosdaq = resKosdaq.json?.output || [];
  console.log(`KOSDAQ returned ${listKosdaq.length} items.`);
  listKosdaq.forEach((s, idx) => {
    console.log(`  ${idx+1}. [${s.stck_shrn_iscd || s.mksc_shrn_iscd}] ${s.hts_kor_isnm}: rate=${s.prdy_ctrt}%, price=${s.stck_prpr}`);
  });
}

runDetailedShdTests().catch(console.error);
