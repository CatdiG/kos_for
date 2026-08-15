const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      env[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
});

async function testRankSort1() {
  const appKey = env.KIS_APPKEY;
  const appSecret = env.KIS_APPSECRET;
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

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

  // Test FID_RANK_SORT_CLS_CODE = 0 vs 1
  for (const sortCode of ['0', '1']) {
    const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_RANK_SORT_CLS_CODE=${sortCode}&FID_ETC_CLS_CODE=1`;
    const res = await fetch(url, {
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
    const json = await res.json();
    console.log(`\n=== FID_RANK_SORT_CLS_CODE: ${sortCode} ===`);
    if (json.output && json.output.length > 0) {
      json.output.slice(0, 15).forEach((item, idx) => {
        const pbmn = parseInt(item.frgn_ntby_tr_pbmn || '0', 10);
        const pbmnEok = (pbmn / 100).toFixed(1);
        const qty = parseInt(item.frgn_ntby_qty || '0', 10);
        const prpr = parseInt(item.stck_prpr || '0', 10);
        console.log(`  ${idx+1}위: ${item.hts_kor_isnm} (${item.mksc_shrn_iscd}) | 현재가: ${prpr}원 | 수량: ${qty}주 | KIS pbmn: ${pbmn}백만원 (${pbmnEok}억원)`);
      });
    }
    await new Promise(r => setTimeout(r, 600));
  }
}

testRankSort1();
