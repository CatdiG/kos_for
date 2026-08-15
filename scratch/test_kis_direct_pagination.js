const fs = require('fs');
const path = require('path');

async function testKisDirectPagination() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) KIS API 직접 호출 멀티 페이지네이션 (최소 60~120일치 수신)');
  console.log('====================================================================================================\n');

  try {
    // Read .env.local for credentials
    const envPath = path.join(__dirname, '../.env.local');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const envVars = {};
    envContent.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        envVars[parts[0].trim()] = parts.slice(1).join('=').trim();
      }
    });

    const appKey = envVars.KIS_APPKEY;
    const appSecret = envVars.KIS_APPSECRET;
    const baseUrl = envVars.KIS_BASE_URL || 'https://openapivts.koreainvestment.com:29443';

    // Get token
    const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        appsecret: appSecret,
      }),
    });
    const tokenJson = await tokenRes.json();
    const token = tokenJson.access_token;
    console.log('Access Token acquired:', token ? 'Success' : 'Failed');

    let allItems = [];
    let endDate = '20260814';

    for (let page = 1; page <= 4; page++) {
      const py = parseInt(endDate.slice(0, 4), 10);
      const pm = parseInt(endDate.slice(4, 6), 10) - 1;
      const pd = parseInt(endDate.slice(6, 8), 10);
      const startObj = new Date(py, pm, pd);
      startObj.setDate(startObj.getDate() - 100);
      const startDate = startObj.toISOString().slice(0, 10).replace(/-/g, '');

      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=459550&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

      console.log(`[Page ${page}] Fetching: FID_INPUT_DATE_1=${startDate} ~ FID_INPUT_DATE_2=${endDate}`);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST03010100',
          custtype: 'P',
        },
      });

      const json = await res.json();
      const output2 = json.output2 || [];
      console.log(`[Page ${page}] Response items count: ${output2.length}`);

      if (output2.length === 0) break;

      const pageAsc = output2.slice().reverse();
      allItems = [...pageAsc, ...allItems];

      const oldestInPage = pageAsc[0].stck_bsop_date || pageAsc[0].bsop_date;
      console.log(`[Page ${page}] Oldest Date in page: ${oldestInPage}`);

      // Set new endDate to 1 day before oldestInPage
      const oy = parseInt(oldestInPage.slice(0, 4), 10);
      const om = parseInt(oldestInPage.slice(4, 6), 10) - 1;
      const od = parseInt(oldestInPage.slice(6, 8), 10);
      const prevDayObj = new Date(oy, om, od);
      prevDayObj.setDate(prevDayObj.getDate() - 1);
      endDate = prevDayObj.toISOString().slice(0, 10).replace(/-/g, '');

      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n총 수신된 일수: ${allItems.length}일`);
    if (allItems.length > 0) {
      console.log(`가장 오래된 날짜: ${allItems[0].stck_bsop_date || allItems[0].bsop_date}`);
      console.log(`가장 최근 날짜  : ${allItems[allItems.length - 1].stck_bsop_date || allItems[allItems.length - 1].bsop_date}`);
    }

  } catch (err) {
    console.error('Error testing direct pagination:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

testKisDirectPagination();
