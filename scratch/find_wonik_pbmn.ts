import path from 'path';
import fs from 'fs';

const envPath = path.resolve(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      process.env[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
});

async function findWonikPbmn() {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
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

  // Test 1: FHKST01010900 (주식시세 - 종목별 주체별 매매 동향 / inquire-investor)
  console.log('\n--- 1. FHKST01010900 (inquire-investor for 240810) ---');
  const url1 = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=240810`;
  const res1 = await fetch(url1, {
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
  const json1 = await res1.json();
  console.log('FHKST01010900 msg1:', json1.msg1);
  if (json1.output && json1.output.length > 0) {
    console.log('Latest row:', json1.output[0]);
  }

  // Test 2: FHKST03010100 / HHPTC00000400 / etc.
  console.log('\n--- 2. FHPTJ04400000 with FID_RANK_SORT_CLS_CODE=1 ---');
  const url2 = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=1001&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=1&FID_ETC_CLS_CODE=1`;
  const res2 = await fetch(url2, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHPTJ04400000',
      custtype: 'P',
    },
  });
  const json2 = await res2.json();
  if (json2.output) {
    const wonik2 = json2.output.find((item: any) => item.hts_kor_isnm?.includes('원익') || item.mksc_shrn_iscd === '240810');
    console.log('Wonik IPS in sort=1:', wonik2);
  }
}

findWonikPbmn();
