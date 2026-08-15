const fs = require('fs');
const path = require('path');

// Read .env.local manually
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

console.log('Env Check:', {
  KIS_APPKEY: process.env.KIS_APPKEY ? `${process.env.KIS_APPKEY.slice(0, 6)}...` : 'MISSING',
  KIS_APPSECRET: process.env.KIS_APPSECRET ? `${process.env.KIS_APPSECRET.slice(0, 6)}...` : 'MISSING',
  KIS_VIRTUAL: process.env.KIS_VIRTUAL,
});

async function runTest() {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';

  console.log('\n1. Testing OAuth Token Request to Production Server...');
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    }),
  });

  console.log('OAuth HTTP Status:', tokenRes.status);
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('OAuth Failed:', tokenData);
    return;
  }

  console.log('OAuth Success! Token length:', tokenData.access_token.length);

  console.log('\n2. Testing Foreign/Institution Ranking TR (FHPTJ04400000)...');
  const rankUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1`;
  const rankRes = await fetch(rankUrl, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${tokenData.access_token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHPTJ04400000',
      custtype: 'P',
    },
  });

  console.log('Rank TR HTTP Status:', rankRes.status);
  const rankData = await rankRes.json();
  console.log('Rank TR rt_cd:', rankData.rt_cd, 'msg1:', rankData.msg1);
  if (Array.isArray(rankData.output)) {
    console.log('First Stock:', rankData.output[0]?.hts_kor_isnm, 'Net Buy:', rankData.output[0]?.frgn_ntby_tr_pbmn);
  }
}

runTest().catch((e) => console.error('Exception:', e));
