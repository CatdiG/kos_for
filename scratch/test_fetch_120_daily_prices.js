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

  const symbol = '005930'; // 삼성전자
  const today = '20260814';
  // 180 calendar days ago (~120 trading days)
  const startDate = '20260214';

  const chartPath = `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${today}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  const res = await fetchKis(chartPath, 'FHKST03010100', token);

  if (res.output2 && res.output2.length > 0) {
    console.log(`Fetched ${res.output2.length} daily items from KIS API (Ascending order)`);
    const fullDailyItems = res.output2.slice().reverse();

    // Calculate MA over full 120 items
    const fullTrendWithMA = fullDailyItems.map((item, idx, arr) => {
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
        isMa60Accurate: slice60.length === 60,
      };
    });

    const display60 = fullTrendWithMA.slice(-60);
    console.log(`Displaying 60d view items count: ${display60.length}`);
    console.log(`Is Day 1 of 60d view ma60 accurate (has 60 preceding days)? -> ${display60[0].isMa60Accurate}`);
    console.log(`Day 1 of 60d view (${display60[0].date}): Close=${display60[0].closePrice.toLocaleString()}원, MA5=${display60[0].ma5.toLocaleString()}원, MA20=${display60[0].ma20.toLocaleString()}원, MA60=${display60[0].ma60.toLocaleString()}원`);
    console.log(`Day 60 of 60d view (${display60[59].date}): Close=${display60[59].closePrice.toLocaleString()}원, MA5=${display60[59].ma5.toLocaleString()}원, MA20=${display60[59].ma20.toLocaleString()}원, MA60=${display60[59].ma60.toLocaleString()}원`);
  } else {
    console.log("Res error:", res);
  }
}

main().catch(console.error);
