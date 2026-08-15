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

async function inspectRawFields() {
  console.log('--- Inspecting Raw Output Keys for FHPST01700000 & FHPST01710000 ---');
  
  const p1 = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
  const res1 = await testApi('FHPST01700000', p1);
  if (res1.json?.output?.[0]) {
    console.log('FHPST01700000 Keys:', Object.keys(res1.json.output[0]));
    console.log('FHPST01700000 Item 0:', res1.json.output[0]);
  }

  const p2 = `/uapi/domestic-stock/v1/quotations/volume-rank?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=0&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_INPUT_CNT_1=0`;
  const res2 = await testApi('FHPST01710000', p2);
  if (res2.json?.output?.[0]) {
    console.log('\nFHPST01710000 Keys:', Object.keys(res2.json.output[0]));
    console.log('FHPST01710000 Item 0:', res2.json.output[0]);
  }
}

inspectRawFields().catch(console.error);
