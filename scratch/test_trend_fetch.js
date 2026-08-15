const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      process.env[key] = val;
    }
  });
}

const baseUrl = 'https://openapi.koreainvestment.com:9443';
const appKey = process.env.KIS_APPKEY;
const appSecret = process.env.KIS_APPSECRET;

async function run() {
  console.log('1. Getting Token...');
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  console.log('Token OK:', !!token);

  console.log('\n2. Testing inquire-investor (FHKST01010900) for 005930...');
  const invRes = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST01010900',
      custtype: 'P',
    },
  });
  console.log('inquire-investor HTTP status:', invRes.status);
  const invJson = await invRes.json();
  console.log('inquire-investor rt_cd:', invJson.rt_cd, 'msg1:', invJson.msg1, 'output length:', invJson.output?.length);

  console.log('\n3. Testing inquire-daily-itemchartprice (FHKST03010100) for 005930...');
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDateObj = new Date(today);
  startDateObj.setDate(startDateObj.getDate() - 365);
  const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

  const chartRes = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST03010100',
      custtype: 'P',
    },
  });
  console.log('chart HTTP status:', chartRes.status);
  const chartJson = await chartRes.json();
  console.log('chart rt_cd:', chartJson.rt_cd, 'msg1:', chartJson.msg1, 'output2 length:', chartJson.output2?.length);
}

run().catch((e) => console.error(e));
