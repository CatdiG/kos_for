const fs = require('fs');
const path = require('path');

async function testKisDailyChartStatus() {
  console.log('\n====================================================================================================');
  console.log('KIS inquire-daily-itemchartprice (FHKST03010100) output2 아이템 개수 확인');
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
    const isVirtual = envVars.KIS_VIRTUAL !== 'false';
    const defaultBaseUrl = isVirtual 
      ? 'https://openapivts.koreainvestment.com:29443' 
      : 'https://openapi.koreainvestment.com:9443';
    const baseUrl = envVars.KIS_BASE_URL || defaultBaseUrl;

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

    const today = new Date();
    const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDateObj = new Date(today);
    startDateObj.setDate(startDateObj.getDate() - 365);
    const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

    const symbol = '005930'; // 삼성전자
    const dailyChartUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

    const res = await fetch(dailyChartUrl, {
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
    console.log(`- 삼성전자 output2 1페이지 수신 아이템 개수: ${output2.length}개`);
    if (output2.length > 0) {
      console.log(`- output2[0] (가장 최근 날짜) : ${output2[0].stck_bsop_date}`);
      console.log(`- output2[${output2.length - 1}] (가장 오래된 날짜): ${output2[output2.length - 1].stck_bsop_date}`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

testKisDailyChartStatus();
