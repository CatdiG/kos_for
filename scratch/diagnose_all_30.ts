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

async function diagnoseAll30() {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';

  // Token
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  // 1. Fetch ranking TR (FHPTJ04400000) for KOSDAQ (inputIscd: 1001)
  const rankUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=1001&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1`;
  const res = await fetch(rankUrl, {
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
  const rawList = json.output;
  console.log(`Received ${rawList.length} items from FHPTJ04400000.`);

  // 2. Fetch FHKST01010900 for each item sequentially with retry/rate limit handling
  const results = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    const sym = item.mksc_shrn_iscd;
    const name = item.hts_kor_isnm;
    const price = parseInt(item.stck_prpr || '0', 10);
    const fhptjQty = parseInt(item.frgn_ntby_qty || '0', 10);
    const fhptjPbmn = parseInt(item.frgn_ntby_tr_pbmn || '0', 10);

    let rawPbmn = 0;
    let rawQty = 0;
    let status = 'SUCCESS';
    let errMsg = '';

    try {
      const invUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${sym}`;
      const invRes = await fetch(invUrl, {
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
      const invJson = await invRes.json();
      if (invJson.rt_cd === '0' && invJson.output && invJson.output.length > 0) {
        const row = invJson.output[0];
        rawPbmn = parseInt(row.frgn_ntby_tr_pbmn || '0', 10);
        rawQty = parseInt(row.frgn_ntby_qty || '0', 10);
      } else {
        status = 'FAIL_API';
        errMsg = invJson.msg1 || 'No output';
      }
    } catch (e: any) {
      status = 'FAIL_FETCH';
      errMsg = e.message;
    }

    results.push({
      index: i + 1,
      sym,
      name,
      price,
      fhptjQty,
      fhptjPbmn,
      fhptjEok: (fhptjPbmn / 100).toFixed(1),
      rawPbmn,
      rawQty,
      rawEok: (rawPbmn / 100).toFixed(1),
      status,
      errMsg,
      matches: fhptjPbmn === rawPbmn
    });

    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n--- 30 Items Diagnosis ---');
  results.forEach(r => {
    console.log(`[${r.index}] ${r.name} (${r.sym}): status=${r.status} | FHPTJ pbmn=${r.fhptjPbmn} (${r.fhptjEok}억) | FHKST raw_pbmn=${r.rawPbmn} (${r.rawEok}억) | raw_qty=${r.rawQty} | match=${r.matches}`);
  });
}

diagnoseAll30();
