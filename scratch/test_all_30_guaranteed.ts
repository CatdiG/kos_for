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

async function fetchWithRetryLocal(fetchFn: () => Promise<any>, maxRetries = 3, baseDelay = 600) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchFn();
      const json = await res.json();
      if (json.rt_cd === '1' || json.msg1?.includes('초당')) {
        throw new Error(`[RateLimit] ${json.msg1 || '초당 거래건수 초과'}`);
      }
      return json;
    } catch (err: any) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function testGuaranteed30() {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';

  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  // 1. Fetch ranking TR (FHPTJ04400000) for KOSDAQ (inputIscd: 1001)
  const rankUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=1001&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1`;
  const rankRes = await fetch(rankUrl, {
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
  const rankJson = await rankRes.json();
  const rawList = rankJson.output;

  console.log(`Testing 100% guaranteed fetch for all ${rawList.length} items...`);
  const finalItems = [];

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    const sym = item.mksc_shrn_iscd;
    const name = item.hts_kor_isnm;
    const price = parseInt(item.stck_prpr || '0', 10);
    const fhptjQty = parseInt(item.frgn_ntby_qty || '0', 10);
    const fhptjPbmn = parseInt(item.frgn_ntby_tr_pbmn || '0', 10);

    let rawPbmn = fhptjPbmn;
    let rawQty = fhptjQty;
    let success = false;

    try {
      const invUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${sym}`;
      const json = await fetchWithRetryLocal(() => fetch(invUrl, {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010900',
          custtype: 'P',
        },
      }));

      if (json.output && json.output.length > 0) {
        const row = json.output[0];
        const pb = parseInt(row.frgn_ntby_tr_pbmn || '0', 10);
        const qt = parseInt(row.frgn_ntby_qty || '0', 10);
        if (pb !== 0 || qt !== 0) {
          rawPbmn = pb;
          rawQty = qt;
          success = true;
        }
      }
    } catch (e) {
      console.error(`[Error ${name} ${sym}]`, (e as Error).message);
    }

    finalItems.push({
      symbol: sym,
      name,
      price,
      rawPbmn,
      rawQty,
      rawEok: (rawPbmn / 100).toFixed(1),
      success
    });

    await new Promise(r => setTimeout(r, 220));
  }

  // Sort strictly by rawPbmn descending
  finalItems.sort((a, b) => b.rawPbmn - a.rawPbmn);

  console.log('\n--- Guaranteed 30 Items Final Verified List ---');
  let successCount = 0;
  finalItems.forEach((item, idx) => {
    if (item.success) successCount++;
    console.log(`${idx + 1}위: ${item.name} (${item.symbol}) | 현재가: ${item.price.toLocaleString()}원 | 수량: ${item.rawQty.toLocaleString()}주 | KIS 원본 pbmn: ${item.rawPbmn}백만원 (${item.rawEok}억원) | enriched=${item.success}`);
  });
  console.log(`\nSuccess rate: ${successCount} / ${finalItems.length}`);
}

testGuaranteed30();
