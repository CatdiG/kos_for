import { getKisAccessToken } from '../src/lib/kisApi';

async function testKisRankingApis() {
  console.log('--- Testing KIS Ranking APIs (FHPST01700000 & FHPST01710000) ---');
  const token = await getKisAccessToken();
  console.log('Token status:', token ? 'Token obtained' : 'No token (Mock Mode)');

  const appKey = process.env.KIS_APPKEY || '';
  const appSecret = process.env.KIS_APPSECRET || '';
  const isVirtual = process.env.KIS_VIRTUAL !== 'false';
  const defaultBaseUrl = isVirtual 
    ? 'https://openapivts.koreainvestment.com:29443' 
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  if (token) {
    // 1. Test Price Fluctuation Rank (등락률 상위 - FHPST01700000)
    console.log('\n1. Requesting FHPST01700000 (Price Fluctuation Rank)...');
    const flucUrl = `${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=0000&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0`;
    const flucRes = await fetch(flucUrl, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHPST01700000',
        custtype: 'P',
      },
    });
    console.log('Fluctuation Rank HTTP Status:', flucRes.status);
    if (flucRes.ok) {
      const json = await flucRes.json();
      console.log('Fluctuation output count:', json.output?.length || 0);
      if (json.output && json.output.length > 0) {
        console.log('Top 3 Fluctuation Items:', json.output.slice(0, 3));
      }
    } else {
      console.log('Fluctuation error body:', await flucRes.text());
    }

    // 2. Test Volume Rank (거래량/거래대금 상위 - FHPST01710000)
    console.log('\n2. Requesting FHPST01710000 (Volume Rank)...');
    const volUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=0&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0`;
    const volRes = await fetch(volUrl, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHPST01710000',
        custtype: 'P',
      },
    });
    console.log('Volume Rank HTTP Status:', volRes.status);
    if (volRes.ok) {
      const json = await volRes.json();
      console.log('Volume output count:', json.output?.length || 0);
      if (json.output && json.output.length > 0) {
        console.log('Top 3 Volume Items:', json.output.slice(0, 3));
      }
    } else {
      console.log('Volume error body:', await volRes.text());
    }
  }
}

testKisRankingApis().catch(console.error);
