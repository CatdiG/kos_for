const fs = require('fs');
const path = require('path');

async function testAdjustedPrice() {
  console.log('\n====================================================================================================');
  console.log('유티아이 (179900) 수정주가(FID_ORG_ADJ_PRC=1) vs 원주가(FID_ORG_ADJ_PRC=0) 비교');
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
    const baseUrl = envVars.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

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
    startDateObj.setDate(startDateObj.getDate() - 120);
    const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

    // 1. Unadjusted (FID_ORG_ADJ_PRC=0)
    const url0 = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=179900&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
    const res0 = await fetch(url0, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST03010100', custtype: 'P' }
    });
    const json0 = await res0.json();

    // 2. Adjusted (FID_ORG_ADJ_PRC=1) -> 수정주가 적용!
    const url1 = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=179900&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=1`;
    const res1 = await fetch(url1, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST03010100', custtype: 'P' }
    });
    const json1 = await res1.json();

    const list0 = (json0.output2 || []).slice().reverse();
    const list1 = (json1.output2 || []).slice().reverse();

    console.log('--- 2026.05.21 (수정주가 vs 원주가 비교) ---');
    const d0_may = list0.find(d => d.stck_bsop_date === '20260521');
    const d1_may = list1.find(d => d.stck_bsop_date === '20260521');
    console.log(`[원주가   FID_ORG_ADJ_PRC=0]: open ${d0_may?.stck_oprc}원 | high ${d0_may?.stck_hgpr}원 | close ${d0_may?.stck_clpr}원`);
    console.log(`[수정주가 FID_ORG_ADJ_PRC=1]: open ${d1_may?.stck_oprc}원 | high ${d1_may?.stck_hgpr}원 | close ${d1_may?.stck_clpr}원`);

    console.log('\n--- 2026.08.14 (최근 날짜 비교) ---');
    const d0_aug = list0.find(d => d.stck_bsop_date === '20260814');
    const d1_aug = list1.find(d => d.stck_bsop_date === '20260814');
    console.log(`[원주가   FID_ORG_ADJ_PRC=0]: open ${d0_aug?.stck_oprc}원 | high ${d0_aug?.stck_hgpr}원 | close ${d0_aug?.stck_clpr}원`);
    console.log(`[수정주가 FID_ORG_ADJ_PRC=1]: open ${d1_aug?.stck_oprc}원 | high ${d1_aug?.stck_hgpr}원 | close ${d1_aug?.stck_clpr}원`);

  } catch (err) {
    console.error('Error testing adjusted price:', err.message);
  }

  console.log('\n====================================================================================================\n');
}

testAdjustedPrice();
