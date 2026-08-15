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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
          if (!json.access_token) {
            console.log("Token error body:", body);
          }
          resolve(json.access_token || null);
        } catch(e) { 
          console.log("Token parse error:", body);
          resolve(null); 
        }
      });
    });
    req.on('error', (e) => {
      console.log("Token req err:", e);
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}

async function fetchKis(pathStr, trId, token) {
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
          resolve(JSON.parse(body));
        } catch(e) { resolve({ error: e.message, raw: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function main() {
  console.log("Starting main...");
  const token = await getAccessToken();
  if (!token) {
    console.log("No token obtained");
    return;
  }

  const symbol = '459500'; // 알트 (ALT)
  console.log(`Testing Symbol: ${symbol} (알트) with 1500ms delay...`);

  await sleep(1500);

  // 2. inquire-daily-itemchartprice (FHKST03010100)
  const today = '20260814';
  const startDate = '20260701';
  const chartPath = `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${today}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const chartRes = await fetchKis(chartPath, 'FHKST03010100', token);
  console.log(`\n[2] inquire-daily-itemchartprice (FHKST03010100): rt_cd=${chartRes.rt_cd}, msg1=${chartRes.msg1}`);
  if (chartRes.output2 && chartRes.output2.length > 0) {
    console.log(`output2 count: ${chartRes.output2.length}`);
    console.log(`Latest 5 items OHLC from KIS API:`);
    chartRes.output2.slice(0, 5).forEach(item => {
      console.log(`Date: ${item.stck_bsop_date} | Open(stck_oprc): ${item.stck_oprc} | High(stck_hgpr): ${item.stck_hgpr} | Low(stck_lwpr): ${item.stck_lwpr} | Close(stck_clpr): ${item.stck_clpr} | Vol: ${item.acml_vol}`);
    });
  } else {
    console.log(`chartRes:`, chartRes);
  }
}

main().catch(console.error);
