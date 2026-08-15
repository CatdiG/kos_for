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
const defaultBaseUrl = isVirtual 
  ? 'https://openapivts.koreainvestment.com:29443' 
  : 'https://openapi.koreainvestment.com:9443';
const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

console.log(`AppKey present: ${Boolean(appKey)}, AppSecret present: ${Boolean(appSecret)}`);

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

async function queryRawIntradayRanking() {
  const token = await getAccessToken();
  if (!token) {
    console.error('Failed to obtain token!');
    return;
  }

  console.log('=== Live Raw Query for FHPTJ04400000 (No Cache) ===');
  console.log(`Execution Time: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);

  const pathStr = `/uapi/domestic-stock/v1/ranking/foreign-institution-total?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=0&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_INPUT_CNT_1=0`;

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
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        console.log(`HTTP Status: ${res.statusCode}`);
        try {
          const json = JSON.parse(body);
          console.log(`rt_cd: ${json.rt_cd}`);
          console.log(`msg_cd: ${json.msg_cd}, msg1: "${json.msg1}"`);
          
          if (json.output && json.output.length > 0) {
            console.log(`Returned Items Count: ${json.output.length}`);
            console.log('\n--- Top 3 Items Raw Output ---');
            json.output.slice(0, 3).forEach((item, idx) => {
              console.log(`[Item ${idx + 1}] Symbol: ${item.stck_shrn_iscd || item.mksc_shrn_iscd}, Name: ${item.hts_kor_isnm}`);
              console.log(`  stck_prpr (현재가): ${item.stck_prpr}`);
              console.log(`  glob_ntby_qty (외국인순매수수량): "${item.glob_ntby_qty}"`);
              console.log(`  glob_ntby_tr_pbmn (외국인순매수대금): "${item.glob_ntby_tr_pbmn}"`);
              console.log(`  orgn_ntby_qty (기관순매수수량): "${item.orgn_ntby_qty}"`);
              console.log(`  orgn_ntby_tr_pbmn (기관순매수대금): "${item.orgn_ntby_tr_pbmn}"`);
            });
          } else {
            console.log('json.output is EMPTY or not an array:', json);
          }
          resolve(json);
        } catch(e) {
          console.error('Raw Body Output:', body);
          resolve(null);
        }
      });
    });
    req.end();
  });
}

queryRawIntradayRanking().catch(console.error);
