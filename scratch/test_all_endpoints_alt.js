const https = require('https');
const fs = require('fs');
const path = require('path');

console.log("Script starting...");

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

async function fetchNaverDaily(symbol) {
  return new Promise((resolve) => {
    const req = https.get(`https://api.finance.naver.com/siseJson.naver?symbol=${symbol}&requestType=1&startTime=20260701&endTime=20260815&timeframe=day`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve(body);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
  });
}

async function main() {
  console.log("Fetching Token...");
  const token = await getAccessToken();
  if (!token) {
    console.log("No token obtained");
    return;
  }
  console.log("Token obtained successfully.");

  const symbol = '459500';

  console.log(`\n=== Testing Naver Finance Sise API for ${symbol} (알트) ===`);
  const naverRaw = await fetchNaverDaily(symbol);
  console.log('Naver raw:', naverRaw ? naverRaw.trim().slice(0, 500) : 'null');

  await sleep(1000);

  console.log(`\n=== Testing KIS Endpoint 1: inquire-price (FHKST01010100) ===`);
  const pricePath = `/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const priceRes = await fetchKis(pricePath, 'FHKST01010100', token);
  console.log(`rt_cd: ${priceRes.rt_cd}, msg1: ${priceRes.msg1}`);
  if (priceRes.output) {
    console.log(`Current Price (stck_prpr): ${priceRes.output.stck_prpr}`);
    console.log(`Open (stck_oprc): ${priceRes.output.stck_oprc}`);
    console.log(`High (stck_hgpr): ${priceRes.output.stck_hgpr}`);
    console.log(`Low (stck_lwpr): ${priceRes.output.stck_lwpr}`);
  }

  await sleep(1000);

  console.log(`\n=== Testing KIS Endpoint 2: inquire-daily-price (FHKST01010400) ===`);
  const dPricePath = `/uapi/domestic-stock/v1/quotations/inquire-daily-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const dPriceRes = await fetchKis(dPricePath, 'FHKST01010400', token);
  console.log(`rt_cd: ${dPriceRes.rt_cd}, msg1: ${dPriceRes.msg1}`);
  if (dPriceRes.output && dPriceRes.output.length > 0) {
    console.log(`dPriceRes output count: ${dPriceRes.output.length}`);
    console.log(`Item 0: Date=${dPriceRes.output[0].stck_bsop_date}, Open=${dPriceRes.output[0].stck_oprc}, High=${dPriceRes.output[0].stck_hgpr}, Low=${dPriceRes.output[0].stck_lwpr}, Close=${dPriceRes.output[0].stck_clpr}`);
  } else {
    console.log(`dPriceRes:`, dPriceRes);
  }

  await sleep(1000);

  console.log(`\n=== Testing KIS Endpoint 3: inquire-daily-itemchartprice (FHKST03010100) with date 20260101 ~ 20260815 ===`);
  const chartPath = `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=20260101&FID_INPUT_DATE_2=20260815&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const chartRes = await fetchKis(chartPath, 'FHKST03010100', token);
  console.log(`rt_cd: ${chartRes.rt_cd}, msg1: ${chartRes.msg1}`);
  if (chartRes.output2 && chartRes.output2.length > 0) {
    console.log(`output2 count: ${chartRes.output2.length}`);
    console.log(`Item 0: Date=${chartRes.output2[0].stck_bsop_date}, Open=${chartRes.output2[0].stck_oprc}, High=${chartRes.output2[0].stck_hgpr}, Low=${chartRes.output2[0].stck_lwpr}, Close=${chartRes.output2[0].stck_clpr}`);
  } else {
    console.log(`chartRes msg:`, chartRes.msg1);
  }
}

main().catch(console.error);
