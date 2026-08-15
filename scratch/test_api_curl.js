const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      let value = match[2] || '';
      if (value.length > 0 && value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1);
      }
      process.env[match[1]] = value;
    }
  });
}

async function testInquireInvestor() {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';

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

  console.log('Fetching Stock Investor Trend (FHKST01010900 - 삼성전자 005930)...');
  const trendUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=005930`;
  const trendRes = await fetch(trendUrl, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST01010900',
      custtype: 'P',
    },
  });
  const trendJson = await trendRes.json();
  console.log('Trend API status:', trendRes.status, 'rt_cd:', trendJson.rt_cd, 'msg1:', trendJson.msg1);
  console.log('Trend output count:', trendJson.output?.length);
  if (trendJson.output?.length > 0) {
    console.log('First 2 daily items:');
    console.log('  Day 1 (Latest close):', trendJson.output[0].stck_bsop_date, '외인순매수:', trendJson.output[0].frgn_ntby_tr_pbmn, '기관순매수:', trendJson.output[0].orgn_ntby_tr_pbmn);
    console.log('  Day 2:', trendJson.output[1].stck_bsop_date, '외인순매수:', trendJson.output[1].frgn_ntby_tr_pbmn, '기관순매수:', trendJson.output[1].orgn_ntby_tr_pbmn);
  }
}

testInquireInvestor().catch(console.error);
