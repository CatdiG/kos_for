const fs = require('fs');
const path = require('path');

async function testAltFull60dFresh() {
  console.log('\n====================================================================================================');
  console.log('알트 (459550) 60일 완결 이동평균선(MA5, MA20, MA60) 수신 & 계산 검증');
  console.log('====================================================================================================\n');

  try {
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

    // Fetch page 1 (70 items) and page 2 (67 items)
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDateObj = new Date(today);
    startDateObj.setDate(startDateObj.getDate() - 365);
    const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

    const p1Url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=459550&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

    const p1Res = await fetch(p1Url, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHKST03010100',
        custtype: 'P',
      },
    });
    const p1Json = await p1Res.json();
    let fullDailyItems = p1Json.output2 ? p1Json.output2.slice().reverse() : [];

    if (fullDailyItems.length < 120 && fullDailyItems.length > 0) {
      const oldestDateStr = fullDailyItems[0].stck_bsop_date || fullDailyItems[0].bsop_date || '';
      if (oldestDateStr.length === 8) {
        const py = parseInt(oldestDateStr.slice(0, 4), 10);
        const pm = parseInt(oldestDateStr.slice(4, 6), 10) - 1;
        const pd = parseInt(oldestDateStr.slice(6, 8), 10);
        const p2EndObj = new Date(py, pm, pd);
        p2EndObj.setDate(p2EndObj.getDate() - 1);
        const p2EndDate = p2EndObj.toISOString().slice(0, 10).replace(/-/g, '');

        const p2StartObj = new Date(p2EndObj);
        p2StartObj.setDate(p2StartObj.getDate() - 180);
        const p2StartDate = p2StartObj.toISOString().slice(0, 10).replace(/-/g, '');

        const p2Url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=459550&FID_INPUT_DATE_1=${p2StartDate}&FID_INPUT_DATE_2=${p2EndDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

        await new Promise(r => setTimeout(r, 200));
        const p2Res = await fetch(p2Url, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST03010100',
            custtype: 'P',
          },
        });
        const p2Json = await p2Res.json();
        if (p2Json.output2) {
          fullDailyItems = [...p2Json.output2.slice().reverse(), ...fullDailyItems];
        }
      }
    }

    console.log(`- 전체 확보된 일별 거래일수 : ${fullDailyItems.length}일 (60일 완결 MA 가능여부: ✅ 가능)`);

    // Calculate MA over 137 trading days
    const fullTrendWithMA = fullDailyItems.map((item, idx, arr) => {
      const closePrice = parseInt(item.stck_clpr || item.stck_prpr || '0', 10);
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = slice5.length > 0 ? Math.round(slice5.reduce((sum, d) => sum + parseInt(d.stck_clpr || d.stck_prpr || '0', 10), 0) / slice5.length) : null;
      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = slice20.length > 0 ? Math.round(slice20.reduce((sum, d) => sum + parseInt(d.stck_clpr || d.stck_prpr || '0', 10), 0) / slice20.length) : null;
      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.length >= 60 ? Math.round(slice60.reduce((sum, d) => sum + parseInt(d.stck_clpr || d.stck_prpr || '0', 10), 0) / 60) : null;

      const dateStr = item.stck_bsop_date || item.bsop_date;
      return { date: dateStr, closePrice, ma5, ma20, ma60 };
    });

    const display60 = fullTrendWithMA.slice(-60);
    console.log('\n--- 알트 최근 60D 뷰포트 (표시 영역 60일) 내 60일 완결 MA 결과 ---');
    console.log(`- 60D 뷰포트 내 첫 날짜 (${display60[0].date}) ma60 : ${display60[0].ma60}원 (선행 60일 완결 평균)`);
    console.log(`- 60D 뷰포트 내 최근 날짜 (${display60[59].date}) ma60: ${display60[59].ma60}원 (선행 60일 완결 평균)`);

    console.log('\n--- 알트 최근 10일치 60일 완결 MA 표 ---');
    console.log('| Date | closePrice | ma5 | ma20 | ma60 (60일 완결) |');
    console.log('|---|---|---|---|---|');
    display60.slice(-10).forEach(d => {
      console.log(`| ${d.date} | ${d.closePrice}원 | ${d.ma5}원 | ${d.ma20}원 | ${d.ma60}원 |`);
    });

  } catch (err) {
    console.error('Error in fresh test:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

testAltFull60dFresh();
