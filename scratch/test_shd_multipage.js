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

async function runMultiPageTest() {
  console.log('=== Testing Multi-Page Fetching (0, 30, 60) ===');
  let allItems = [];

  for (const pageOffset of ['0', '30', '60']) {
    const p = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=${pageOffset}&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
    const res = await testApi('FHPST01700000', p);
    const list = res.json?.output || [];
    console.log(`Page offset ${pageOffset}: got ${list.length} items.`);
    allItems = allItems.concat(list);
    await sleep(1200);
  }

  console.log(`\nTotal items collected across 3 pages: ${allItems.length}`);

  const uniqueMap = new Map();
  allItems.forEach(item => {
    const sym = item.stck_shrn_iscd || item.mksc_shrn_iscd;
    if (sym && !uniqueMap.has(sym)) {
      uniqueMap.set(sym, item);
    }
  });

  const uniqueItems = Array.from(uniqueMap.values());
  console.log(`Unique items: ${uniqueItems.length}`);

  const shd = uniqueItems.find(s => (s.stck_shrn_iscd || s.mksc_shrn_iscd) === '001770' || (s.hts_kor_isnm && s.hts_kor_isnm.includes('SHD')));
  if (shd) {
    console.log('⭐ SHD FOUND IN MULTI-PAGE FETCH! Details:', shd);
  } else {
    console.log('SHD not found in top 90 items.');
  }

  // Sort uniqueItems by prdy_ctrt float descending
  uniqueItems.sort((a, b) => parseFloat(b.prdy_ctrt || '0') - parseFloat(a.prdy_ctrt || '0'));

  console.log('\nTop 20 items after explicit numeric sort:');
  uniqueItems.slice(0, 20).forEach((item, i) => {
    console.log(`  ${i+1}. [${item.stck_shrn_iscd || item.mksc_shrn_iscd}] ${item.hts_kor_isnm}: changeRate=${item.prdy_ctrt}%, price=${item.stck_prpr}원, vol=${item.acml_vol}`);
  });
}

runMultiPageTest().catch(console.error);
