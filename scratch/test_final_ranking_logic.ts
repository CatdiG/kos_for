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

async function runEnrichedRankingTest() {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';

  // Fetch OAuth Token
  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  // 1. Fetch ranking TR (FHPTJ04400000) for KOSDAQ (inputIscd: 1001)
  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=1001&FID_DIV_CLS_CODE=1&FID_RANK_SORT_CLS_CODE=0&FID_ETC_CLS_CODE=1`;
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
  
  const rawList = json.output.slice(0, 15).map((item: any) => ({
    symbol: item.mksc_shrn_iscd,
    name: item.hts_kor_isnm,
    price: parseInt(item.stck_prpr || '0', 10),
    fhptj_qty: parseInt(item.frgn_ntby_qty || '0', 10),
    fhptj_pbmn: parseInt(item.frgn_ntby_tr_pbmn || '0', 10),
  }));

  console.log('=== Original FHPTJ04400000 values ===');
  rawList.forEach((item: any, i: number) => {
    console.log(`${i+1}위: ${item.name} (${item.symbol}) | price=${item.price} | fhptj_qty=${item.fhptj_qty} | fhptj_pbmn=${item.fhptj_pbmn} (${(item.fhptj_pbmn/100).toFixed(1)}억)`);
  });

  // 2. Enrich with exact FHKST01010900 (inquire-investor) raw values
  console.log('\n=== Enriching with FHKST01010900 raw investor values ===');
  const enriched = await Promise.all(
    rawList.map(async (item: any) => {
      try {
        const invUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${item.symbol}`;
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
        if (invJson.output && invJson.output.length > 0) {
          const row = invJson.output[0];
          const frgnPbmn = parseInt(row.frgn_ntby_tr_pbmn || '0', 10);
          const frgnQty = parseInt(row.frgn_ntby_qty || '0', 10);
          return {
            ...item,
            raw_pbmn: frgnPbmn,
            raw_pbmn_eok: Number((frgnPbmn / 100).toFixed(1)),
            raw_qty: frgnQty,
          };
        }
      } catch (e) {}
      return {
        ...item,
        raw_pbmn: item.fhptj_pbmn,
        raw_pbmn_eok: Number((item.fhptj_pbmn / 100).toFixed(1)),
        raw_qty: item.fhptj_qty,
      };
    })
  );

  // 3. Sort strictly by raw_pbmn (descending)
  enriched.sort((a, b) => b.raw_pbmn - a.raw_pbmn);

  console.log('\n=== Final Verified Enriched Ranking (Sorted by exact KIS raw pbmn) ===');
  enriched.forEach((item: any, i: number) => {
    console.log(`${i+1}위: ${item.name} (${item.symbol}) | 현재가: ${item.price.toLocaleString()}원 | 수량: ${item.raw_qty.toLocaleString()}주 | KIS 원본 pbmn: ${item.raw_pbmn}백만원 (${item.raw_pbmn_eok}억원)`);
  });
}

runEnrichedRankingTest();
