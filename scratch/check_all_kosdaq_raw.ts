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

async function checkStockRawDetails() {
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

  const targets = [
    { symbol: '240810', name: '원익IPS' },
    { symbol: '241710', name: '코스메카코리아' },
    { symbol: '403870', name: 'HPSP' },
    { symbol: '332570', name: 'PS일렉트로닉스' },
    { symbol: '214450', name: '파마리서치' },
  ];

  console.log('--- KIS 원본 FHKST01010900 (종목별 주체별 매매동향) ---');
  for (const t of targets) {
    const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${t.symbol}`;
    const res = await fetch(url, {
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
    const json = await res.json();
    if (json.output && json.output.length > 0) {
      const row = json.output[0];
      const frgnPbmn = parseInt(row.frgn_ntby_tr_pbmn || '0', 10);
      const frgnQty = parseInt(row.frgn_ntby_qty || '0', 10);
      const orgnPbmn = parseInt(row.orgn_ntby_tr_pbmn || '0', 10);
      const orgnQty = parseInt(row.orgn_ntby_qty || '0', 10);
      const prpr = parseInt(row.stck_clpr || row.stck_prpr || '0', 10);

      console.log(`\n종목: ${t.name} (${t.symbol})`);
      console.log(`  현재가: ${prpr.toLocaleString()}원`);
      console.log(`  외국인 순매수 수량 (frgn_ntby_qty): ${frgnQty.toLocaleString()}주`);
      console.log(`  외국인 순매수 대금 (frgn_ntby_tr_pbmn): ${frgnPbmn.toLocaleString()}백만원 -> ${(frgnPbmn / 100).toFixed(1)}억원`);
      console.log(`  기관 순매수 수량 (orgn_ntby_qty): ${orgnQty.toLocaleString()}주`);
      console.log(`  기관 순매수 대금 (orgn_ntby_tr_pbmn): ${orgnPbmn.toLocaleString()}백만원 -> ${(orgnPbmn / 100).toFixed(1)}억원`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
}

checkStockRawDetails();
