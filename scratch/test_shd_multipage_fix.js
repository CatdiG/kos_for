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

async function testFix() {
  console.log('=== Testing Multi-Page Fetch & Numeric Sort Fix ===');
  let rawOutputs = [];

  // Fetch 3 pages (offsets 0, 30, 60)
  for (const offset of ['0', '30', '60']) {
    const urlStr = `/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=${offset}&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
    const res = await testApi('FHPST01700000', urlStr);
    if (res.json?.output && Array.isArray(res.json.output)) {
      rawOutputs = rawOutputs.concat(res.json.output);
    }
    await sleep(800);
  }

  console.log(`Raw items count fetched: ${rawOutputs.length}`);

  const itemMap = new Map();
  rawOutputs.forEach((item) => {
    const sym = item.stck_shrn_iscd || item.mksc_shrn_iscd || '';
    if (sym && !itemMap.has(sym)) {
      itemMap.set(sym, {
        symbol: sym,
        name: item.hts_kor_isnm || '',
        price: parseInt(item.stck_prpr || '0', 10),
        changeRate: parseFloat(item.prdy_ctrt || '0'),
        volume: parseInt(item.acml_vol || '0', 10),
      });
    }
  });

  const list = Array.from(itemMap.values());
  list.sort((a, b) => b.changeRate - a.changeRate);
  list.forEach((item, i) => { item.rank = i + 1; });

  console.log('\nTop 12 items after fix:');
  list.slice(0, 12).forEach((item) => {
    console.log(`  Rank ${item.rank}: [${item.symbol}] ${item.name} | Price: ${item.price.toLocaleString()}원 | Change: +${item.changeRate.toFixed(2)}% | Vol: ${item.volume.toLocaleString()}주`);
  });
}

testFix().catch(console.error);
