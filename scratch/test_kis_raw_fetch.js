const fs = require('fs');
const path = require('path');

// Read .env.local
const envLocal = fs.readFileSync('.env.local', 'utf8');
const envVars = {};
envLocal.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) envVars[k.trim()] = v.trim();
});

const appKey = envVars.KIS_APPKEY;
const appSecret = envVars.KIS_APPSECRET;
const isVirtual = envVars.KIS_VIRTUAL !== 'false';
const baseUrl = envVars.KIS_BASE_URL || (isVirtual ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443');

console.log('Using baseUrl:', baseUrl);
console.log('AppKey present:', Boolean(appKey));

async function testFetch() {
  // Get token
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  console.log('Token received:', Boolean(token));

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDateObj = new Date(today);
  startDateObj.setDate(startDateObj.getDate() - 180);
  const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

  console.log(`Querying FHKST03010100 from ${startDate} to ${endDate}...`);

  const dailyChartUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

  const res = await fetch(dailyChartUrl, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST03010100',
      custtype: 'P',
    },
  });

  const json = await res.json();
  console.log('rt_cd:', json.rt_cd);
  console.log('msg1:', json.msg1);
  console.log('output2 length:', json.output2 ? json.output2.length : 'N/A');
  if (json.output2 && json.output2.length > 0) {
    console.log('Oldest item in output2:', json.output2[json.output2.length - 1].stck_bsop_date, 'close:', json.output2[json.output2.length - 1].stck_clpr);
    console.log('Newest item in output2:', json.output2[0].stck_bsop_date, 'close:', json.output2[0].stck_clpr);
  }
}

testFetch().catch(console.error);
