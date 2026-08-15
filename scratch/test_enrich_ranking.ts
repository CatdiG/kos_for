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

async function testEnrich() {
  const { fetchKisForeignInstitutionRanking } = require('../src/lib/kisApi');
  const res = await fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', 'KOSDAQ');
  console.log('Original FHPTJ04400000 ranking top 5:');
  res.list.slice(0, 5).forEach((item: any, idx: number) => {
    console.log(`${idx + 1}위: ${item.name} (${item.symbol}) | price: ${item.currentPrice} | qty: ${item.netBuyQty} | amt: ${item.netBuyAmt} (${item.netBuyAmtEok}억)`);
  });

  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';
  const token = (await (await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret })
  })).json()).access_token;

  console.log('\nEnriched with FHKST01010900 (종목별 주체별 실매매 동향):');
  const enrichedList = await Promise.all(
    res.list.slice(0, 10).map(async (item: any) => {
      try {
        const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${item.symbol}`;
        const resp = await fetch(url, {
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
        const json = await resp.json();
        if (json.output && json.output.length > 0) {
          const row = json.output[0];
          const frgnPbmn = parseInt(row.frgn_ntby_tr_pbmn || '0', 10);
          const frgnQty = parseInt(row.frgn_ntby_qty || '0', 10);
          if (frgnPbmn !== 0 || frgnQty !== 0) {
            return {
              ...item,
              netBuyAmt: frgnPbmn,
              netBuyAmtEok: Number((frgnPbmn / 100).toFixed(1)),
              netBuyQty: frgnQty,
            };
          }
        }
      } catch (e) {}
      return item;
    })
  );

  // Sort by raw KIS netBuyAmt
  enrichedList.sort((a, b) => b.netBuyAmt - a.netBuyAmt);
  enrichedList.forEach((item, idx) => {
    console.log(`${idx + 1}위: ${item.name} (${item.symbol}) | price: ${item.currentPrice}원 | qty: ${item.netBuyQty}주 | amt: ${item.netBuyAmt}백만원 (${item.netBuyAmtEok}억원)`);
  });
}

testEnrich();
