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
  if (!token) return;

  const symbols = ['459550', '005930', '000660']; // 알트, 삼성전자, SK하이닉스
  const today = '20260814';
  const startDate = '20260214';

  for (const symbol of symbols) {
    console.log(`\n========================================`);
    console.log(`Testing Primary DailyChart order for symbol: ${symbol}`);
    
    // 1. Primary call: Daily Chart (FHKST03010100)
    const chartPath = `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${today}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
    const chartRes = await fetchKis(chartPath, 'FHKST03010100', token);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // 2. Secondary call: Investor Trend (FHKST01010900)
    const invPath = `/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
    const invRes = await fetchKis(invPath, 'FHKST01010900', token);

    const chartCount = chartRes.output2 ? chartRes.output2.length : 0;
    const invCount = invRes.output ? invRes.output.length : 0;

    console.log(`Chart Items count: ${chartCount} | Investor Items count: ${invCount}`);

    if (chartCount > 0) {
      const items = chartRes.output2.slice().reverse(); // Ascending date
      const fullTrendWithMA = items.map((item, idx, arr) => {
        const closePrice = parseInt(item.stck_clpr || '0', 10);
        const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
        const ma60 = Math.round(slice60.reduce((sum, d) => sum + parseInt(d.stck_clpr || '0', 10), 0) / slice60.length);

        const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
        const ma20 = Math.round(slice20.reduce((sum, d) => sum + parseInt(d.stck_clpr || '0', 10), 0) / slice20.length);

        const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
        const ma5 = Math.round(slice5.reduce((sum, d) => sum + parseInt(d.stck_clpr || '0', 10), 0) / slice5.length);

        return { date: item.stck_bsop_date, closePrice, ma5, ma20, ma60 };
      });

      const sliced20 = fullTrendWithMA.slice(-20);
      console.log(`20d View - First item: Date=${sliced20[0].date}, MA60=${sliced20[0].ma60}원`);
      console.log(`20d View - Last item: Date=${sliced20[19].date}, MA60=${sliced20[19].ma60}원`);
      console.log(`MA60 Direction over 20d: ${sliced20[0].ma60} -> ${sliced20[19].ma60} (${sliced20[19].ma60 < sliced20[0].ma60 ? 'DOWNWARD ↘' : 'UPWARD ↗'})`);
    }
  }
}

main().catch(console.error);
