const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  content.split(/\r?\n/).forEach((line) => {
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
const baseUrl = isVirtual 
  ? 'https://openapivts.koreainvestment.com:29443' 
  : 'https://openapi.koreainvestment.com:9443';

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

async function testRawFhptj04400000() {
  const token = await getAccessToken();
  console.log(`=== Direct Raw Query of FHPTJ04400000 at ${new Date().toLocaleTimeString()} ===`);
  console.log(`Target Base URL: ${baseUrl} (isVirtual: ${isVirtual})`);
  console.log(`AppKey Prefix: ${appKey.slice(0, 8)}...\n`);

  // Query parameter with cache-busting timestamp
  const timestamp = Date.now();
  const pathStr = `/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1&t=${timestamp}`;

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
        tr_id: 'FHPTJ04400000',
        custtype: 'P',
        'cache-control': 'no-cache, no-store, must-revalidate',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        console.log(`Response status code: ${res.statusCode}`);
        console.log(`Raw Body Length: ${body.length}`);
        console.log(`Raw Body Head: ${body.slice(0, 300)}`);
        try {
          const json = JSON.parse(body);
          console.log(`rt_cd: ${json.rt_cd}, msg_cd: ${json.msg_cd}, msg1: ${json.msg1}`);
          
          if (json.output && Array.isArray(json.output)) {
            console.log(`Total output items returned: ${json.output.length}\n`);
            console.log('--- First 5 Raw Items ---');
            json.output.slice(0, 5).forEach((item, idx) => {
              console.log(`Item ${idx + 1} [${item.hts_kor_isnm || item.stck_shrn_iscd}]:`);
              console.log(`  stck_prpr (현재가): ${item.stck_prpr}`);
              console.log(`  prdy_vrss (대비)  : ${item.prdy_vrss}`);
              console.log(`  prdy_ctrt (등락률): ${item.prdy_ctrt}`);
              console.log(`  acml_vol  (거래량): ${item.acml_vol}`);
              console.log(`  frgn_ntby_tr_pbmn (외국인 순매수대금): ${item.frgn_ntby_tr_pbmn}`);
              console.log(`  orgn_ntby_tr_pbmn (기관 순매수대금)  : ${item.orgn_ntby_tr_pbmn}`);
              console.log(`  frgn_ntby_qty     (외국인 순매수수량): ${item.frgn_ntby_qty}`);
              console.log(`  orgn_ntby_qty     (기관 순매수수량)  : ${item.orgn_ntby_qty}`);
            });
          } else {
            console.log('Raw output is empty or not an array:', json);
          }
          resolve(json);
        } catch(e) {
          console.error('Parse error on raw body:', body);
          resolve(null);
        }
      });
    });
    req.end();
  });
}

testRawFhptj04400000().catch(console.error);
