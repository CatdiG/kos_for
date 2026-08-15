const https = require('https');
const fs = require('fs');
const path = require('path');

// 1. Load env
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

// 2. Step 1: Check master dictionary for "SHD"
console.log('=== Step 1: Master Dictionary Lookup for "SHD" ===');
const masterPath = path.join(__dirname, '../src/lib/data/stockMasterCache.json');
let masterData = [];
if (fs.existsSync(masterPath)) {
  masterData = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
}

const shdMatches = masterData.filter(
  (s) =>
    s.name.toUpperCase().includes('SHD') ||
    s.symbol === '001770' ||
    s.name.includes('신화')
);
console.log('Master Matches for "SHD":', shdMatches);

// 3. Setup KIS API credentials
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

async function runInvestigation() {
  const token = await getAccessToken();
  console.log('\n=== Step 2-A: Searching across 10 Pages of FHPST01700000 ===');
  let allItems = [];
  
  // Query 10 pages (offsets 0, 30, 60, 90, 120, 150, 180, 210, 240, 270)
  for (let i = 0; i < 10; i++) {
    const offset = String(i * 30);
    const p = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=${offset}&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
    const res = await testApi('FHPST01700000', p);
    const list = res.json?.output || [];
    console.log(`Page ${i + 1} (offset=${offset}): got ${list.length} items.`);
    if (list.length > 0) {
      allItems = allItems.concat(list);
    } else {
      break; // No more items
    }
    await sleep(600);
  }

  console.log(`Total raw items collected across all pages: ${allItems.length}`);

  const shdRaw = allItems.find(
    (s) =>
      (s.stck_shrn_iscd || s.mksc_shrn_iscd) === '001770' ||
      (s.hts_kor_isnm && (s.hts_kor_isnm.includes('SHD') || s.hts_kor_isnm.includes('신화')))
  );

  if (shdRaw) {
    console.log('\n⭐ SHD FOUND in FHPST01700000 raw output! Raw item:', shdRaw);
  } else {
    console.log('\n❌ SHD NOT FOUND in any page of FHPST01700000 (Price Fluctuation Rank API)!');
  }

  console.log('\n=== Step 2-B: Direct Inquire Price API (FHKST01010100) for "001770" ===');
  const pricePath = `/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=001770`;
  const priceRes = await testApi('FHKST01010100', pricePath);
  console.log('Inquire Price API Status:', priceRes.status);
  console.log('Inquire Price Raw Output (output):', priceRes.json?.output);
}

runInvestigation().catch(console.error);
