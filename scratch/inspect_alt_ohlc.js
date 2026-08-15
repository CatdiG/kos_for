const https = require('https');
const http = require('http');
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

async function fetchLocalTrend(symbol) {
  return new Promise((resolve) => {
    const url = `http://localhost:3000/api/stock/investor-trend?symbol=${symbol}&period=20d&t=${Date.now()}`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({ error: e.message }); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

async function main() {
  const symbol = '459500'; // 알트
  console.log(`========================================`);
  console.log(`1. Testing Local API Route for ${symbol}`);
  console.log(`========================================`);
  const localData = await fetchLocalTrend(symbol);
  if (localData.trend) {
    console.log(`Total trend items: ${localData.trend.length}`);
    console.log(`Latest 3 items from Local API Route:`);
    localData.trend.slice(-3).forEach(item => {
      console.log(`Date: ${item.formattedDate} (${item.date}) | Open: ${item.openPrice} | High: ${item.highPrice} | Low: ${item.lowPrice} | Close: ${item.closePrice} | Vol: ${item.volume}`);
    });
  } else {
    console.log(`Local API Response:`, localData);
  }

  console.log(`\n========================================`);
  console.log(`2. Testing Direct KIS API Calls for ${symbol}`);
  console.log(`========================================`);
  const token = await getAccessToken();
  if (!token) {
    console.log('Failed to get KIS access token. Check .env.local');
    return;
  }

  // 1) inquire-investor (FHKST01010900)
  const invPath = `/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const invRes = await fetchKis(invPath, 'FHKST01010900', token);
  console.log(`--- [1] inquire-investor (FHKST01010900) ---`);
  console.log(`rt_cd: ${invRes.rt_cd}, msg1: ${invRes.msg1}`);
  if (invRes.output && invRes.output.length > 0) {
    console.log(`Sample item 0 keys:`, Object.keys(invRes.output[0]));
    console.log(`Sample item 0 data:`, invRes.output[0]);
  }

  // 2) inquire-daily-itemchartprice (FHKST03010100)
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - 30);
  const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');
  
  const chartPath = `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${today}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const chartRes = await fetchKis(chartPath, 'FHKST03010100', token);
  console.log(`\n--- [2] inquire-daily-itemchartprice (FHKST03010100) ---`);
  console.log(`rt_cd: ${chartRes.rt_cd}, msg1: ${chartRes.msg1}`);
  if (chartRes.output2 && chartRes.output2.length > 0) {
    console.log(`Sample output2 item 0 keys:`, Object.keys(chartRes.output2[0]));
    console.log(`Sample output2 item 0 data:`, chartRes.output2[0]);
    console.log(`Latest 3 items from inquire-daily-itemchartprice:`);
    chartRes.output2.slice(0, 3).forEach(item => {
      console.log(`Date: ${item.stck_bsop_date} | Open(stck_oprc): ${item.stck_oprc} | High(stck_hgpr): ${item.stck_hgpr} | Low(stck_lwpr): ${item.stck_lwpr} | Close(stck_clpr): ${item.stck_clpr}`);
    });
  } else {
    console.log(`output2 missing or empty. output1:`, chartRes.output1);
  }
}

main().catch(console.error);
