const fs = require('fs');
const path = require('path');
const https = require('https');

const envPath = path.resolve(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const parts = trimmed.split('=');
    if (parts.length >= 2) env[parts[0].trim()] = parts.slice(1).join('=').trim();
  }
});

function fetchNaverRank() {
  return new Promise((resolve) => {
    https.get('https://finance.naver.com/sise/sise_deal_rank.naver', (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const decoder = new TextDecoder('euc-kr');
        const html = decoder.decode(Buffer.concat(chunks));
        const regex = /class="company"[^>]*>([^<]+)<\/a>/g;
        let match;
        const list = [];
        while ((match = regex.exec(html)) !== null) {
          list.push(match[1].trim());
        }
        resolve(list);
      });
    });
  });
}

async function testSimultaneous() {
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  const tokenRes = await fetch(baseUrl + '/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: env.KIS_APPKEY, appsecret: env.KIS_APPSECRET }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  // Execute simultaneous queries
  console.log('Fetching KIS OpenAPI & Naver Finance simultaneously...');
  const [naverList, kisResAmount, kisResQuantity] = await Promise.all([
    fetchNaverRank(),
    fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1`, {
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token, appkey: env.KIS_APPKEY, appsecret: env.KIS_APPSECRET, tr_id: 'FHPTJ04400000', custtype: 'P' },
    }).then(r => r.json()),
    fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1`, {
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token, appkey: env.KIS_APPKEY, appsecret: env.KIS_APPSECRET, tr_id: 'FHPTJ04400000', custtype: 'P' },
    }).then(r => r.json())
  ]);

  console.log('\n--- 1. Naver Finance Ranking (Live) ---');
  naverList.slice(0, 5).forEach((n, i) => console.log(`${i+1}. ${n}`));

  console.log('\n--- 2. KIS OpenAPI Amount Sort (FID_DIV_CLS_CODE=1 - 금액정렬) ---');
  (kisResAmount.output || []).slice(0, 5).forEach((item, i) => {
    const amt = item.frgn_ntby_tr_pbmn || item.ntby_tr_pbmn || '0';
    console.log(`${i+1}. ${item.hts_kor_isnm} (${item.mksc_shrn_iscd}) - 대금: ${amt} 백만원`);
  });

  console.log('\n--- 3. KIS OpenAPI Quantity Sort (FID_DIV_CLS_CODE=0 - 수량정렬) ---');
  (kisResQuantity.output || []).slice(0, 5).forEach((item, i) => {
    const qty = item.frgn_ntby_qty || item.ntby_qty || '0';
    console.log(`${i+1}. ${item.hts_kor_isnm} (${item.mksc_shrn_iscd}) - 수량: ${qty} 주`);
  });
}

testSimultaneous();
