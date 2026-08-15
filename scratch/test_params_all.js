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

async function runParamTests() {
  console.log('--- Testing FHPST01700000 Parameter Variations ---');
  
  // Test variations for FID_RANK_SORT_CLS_CODE (0, 1, 2)
  const sortCodes = ['0', '1', '2'];
  for (const sortCode of sortCodes) {
    const p = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=${sortCode}&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
    const res = await testApi('FHPST01700000', p);
    const list = res.json?.output || [];
    console.log(`\nFID_RANK_SORT_CLS_CODE=${sortCode} returned ${list.length} items.`);
    if (list.length > 0) {
      console.log('Top 3:', list.slice(0, 3).map(s => `${s.hts_kor_isnm}(${s.stck_shrn_iscd}): ${s.prdy_ctrt}%`));
    }
    const shd = list.find(s => (s.stck_shrn_iscd || s.mksc_shrn_iscd) === '001770' || (s.hts_kor_isnm && s.hts_kor_isnm.includes('SHD')));
    if (shd) console.log(`⭐ SHD FOUND with sortCode=${sortCode}:`, shd);
    await sleep(1500);
  }

  // Test variations for FID_TRGT_CLS_CODE & FID_TRGT_EXLS_CLS_CODE
  console.log('\n--- Testing Target Exclusion Filters ---');
  const targetCodes = ['0', '111111111'];
  const exlsCodes = ['0', '000000000'];
  for (const trgt of targetCodes) {
    for (const exls of exlsCodes) {
      const p = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=${trgt}&FID_TRGT_EXLS_CLS_CODE=${exls}&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
      const res = await testApi('FHPST01700000', p);
      const list = res.json?.output || [];
      console.log(`FID_TRGT_CLS_CODE=${trgt}, EXLS=${exls} returned ${list.length} items.`);
      const shd = list.find(s => (s.stck_shrn_iscd || s.mksc_shrn_iscd) === '001770' || (s.hts_kor_isnm && s.hts_kor_isnm.includes('SHD')));
      if (shd) console.log(`⭐ SHD FOUND with trgt=${trgt}, exls=${exls}:`, shd);
      await sleep(1500);
    }
  }
}

runParamTests().catch(console.error);
