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

async function main() {
  const token = await getAccessToken();
  if (!token) {
    console.log("No token obtained");
    return;
  }

  const symbol = '459550';
  const today = '20260814';
  const startDate = '20260214';

  const chartPath = `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${today}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const res = await fetchKis(chartPath, 'FHKST03010100', token);

  if (res.output2 && res.output2.length > 0) {
    const items = res.output2.slice().reverse(); // Ascending date
    console.log(`=== Alt (${symbol}) KIS API Raw Data (Total items: ${items.length}) ===`);

    const trendMA = items.map((item, idx, arr) => {
      const closePrice = parseInt(item.stck_clpr || '0', 10);
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = Math.round(slice5.reduce((sum, d) => sum + parseInt(d.stck_clpr || '0', 10), 0) / slice5.length);

      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = Math.round(slice20.reduce((sum, d) => sum + parseInt(d.stck_clpr || '0', 10), 0) / slice20.length);

      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = Math.round(slice60.reduce((sum, d) => sum + parseInt(d.stck_clpr || '0', 10), 0) / slice60.length);

      return {
        date: item.stck_bsop_date,
        closePrice,
        ma5,
        ma20,
        ma60,
      };
    });

    console.log(`\nLast 15 days MA values (Ascending Date Order - Left to Right on Chart):`);
    trendMA.slice(-15).forEach((d, i, arr) => {
      const prevMa5 = i > 0 ? arr[i - 1].ma5 : d.ma5;
      const ma5Trend = d.ma5 > prevMa5 ? '↗ (상향)' : d.ma5 < prevMa5 ? '↘ (하향)' : '➔ (보합)';
      
      const prevMa20 = i > 0 ? arr[i - 1].ma20 : d.ma20;
      const ma20Trend = d.ma20 > prevMa20 ? '↗ (상향)' : d.ma20 < prevMa20 ? '↘ (하향)' : '➔ (보합)';

      const prevMa60 = i > 0 ? arr[i - 1].ma60 : d.ma60;
      const ma60Trend = d.ma60 > prevMa60 ? '↗ (상향)' : d.ma60 < prevMa60 ? '↘ (하향)' : '➔ (보합)';

      console.log(`Date: ${d.date} | Close: ${d.closePrice} | MA5: ${d.ma5} ${ma5Trend} | MA20: ${d.ma20} ${ma20Trend} | MA60: ${d.ma60} ${ma60Trend}`);
    });
  } else {
    console.log("Res error:", res);
  }
}

main().catch(console.error);
