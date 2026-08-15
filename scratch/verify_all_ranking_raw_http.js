const path = require('path');
const fs = require('fs');

// Load environment variables from .env.local
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        process.env[parts[0].trim()] = parts.slice(1).join('=').trim();
      }
    }
  });
}

function getBaseUrl() {
  const isVirtual = process.env.KIS_VIRTUAL !== 'false';
  const defaultBaseUrl = isVirtual 
    ? 'https://openapivts.koreainvestment.com:29443' 
    : 'https://openapi.koreainvestment.com:9443';
  return process.env.KIS_BASE_URL || defaultBaseUrl;
}

async function getKisToken() {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  const baseUrl = getBaseUrl();

  const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function fetchRawInvestorData(token, symbol) {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  const baseUrl = getBaseUrl();

  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
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
  if (!res.ok) return null;
  const json = await res.json();
  if (json.output && json.output.length > 0) {
    return json.output[0];
  }
  return null;
}

async function verifyHttpRanking() {
  console.log('====================================================================================================');
  console.log('🚀 [실제 API 서버 대조] 랭킹 화면 API 수치 vs KIS 원본 FHKST01010900 pbmn 1:1 대조 및 Top 50 검증');
  console.log('====================================================================================================\n');

  const token = await getKisToken();
  if (!token) {
    console.error('❌ KIS Token 발급 실패');
    return;
  }

  const testCases = [
    { type: 'foreign', direction: 'buy', label: '외국인 순매수 상위 (30개 전수 검증)', limit: 30 },
    { type: 'organ', direction: 'buy', label: '기관 순매수 상위 (Top 50 확장 검증)', limit: 50 },
  ];

  for (const testCase of testCases) {
    console.log(`\n----------------------------------------------------------------------------------------------------`);
    console.log(`📌 [검증 대상] ${testCase.label} (API endpoint: /api/ranking/${testCase.type}?direction=${testCase.direction}&limit=${testCase.limit})`);
    console.log(`----------------------------------------------------------------------------------------------------`);

    const apiUrl = `http://localhost:3000/api/ranking/${testCase.type}?direction=${testCase.direction}&limit=${testCase.limit}&market=ALL`;
    const apiRes = await fetch(apiUrl);
    if (!apiRes.ok) {
      console.error(`❌ API 응답 실패 ${apiRes.status}`);
      continue;
    }

    const data = await apiRes.json();
    const list = data.list || [];

    console.log(`수신된 총 랭킹 종목 수: ${list.length}개\n`);
    console.log(`| 순위 | 종목코드 | 종목명                | 화면 대금 (백만원) | 화면 대금 (억원) | KIS 원본 pbmn (백만원) | KIS 원본 억원 | 대조 결과     |`);
    console.log(`|------|----------|-----------------------|--------------------|------------------|-----------------------|----------------|---------------|`);

    let matchCount = 0;
    let mismatchCount = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const rawData = await fetchRawInvestorData(token, item.symbol);
      let rawPbmn = 0;
      let rawQty = 0;

      if (rawData) {
        if (testCase.type === 'foreign') {
          rawPbmn = parseInt(rawData.frgn_ntby_tr_pbmn || '0', 10);
          rawQty = parseInt(rawData.frgn_ntby_qty || '0', 10);
        } else {
          rawPbmn = parseInt(rawData.orgn_ntby_tr_pbmn || '0', 10);
          rawQty = parseInt(rawData.orgn_ntby_qty || '0', 10);
        }
      }

      const rawEok = Number((rawPbmn / 100).toFixed(1));
      const isMatch = item.netBuyAmt === rawPbmn && item.netBuyAmtEok === rawEok;

      if (isMatch) {
        matchCount++;
      } else {
        mismatchCount++;
      }

      const statusTag = isMatch ? '✅ 1:1 일치' : '❌ 불일치';
      const formattedName = (item.name || '').padEnd(10);
      console.log(
        `| ${String(item.rank).padStart(4)} | ${item.symbol} | ${formattedName} | ${String(item.netBuyAmt.toLocaleString()).padStart(18)} | ${String(item.netBuyAmtEok).padStart(16)} | ${String(rawPbmn.toLocaleString()).padStart(21)} | ${String(rawEok).padStart(14)} | ${statusTag} |`
      );

      await new Promise((r) => setTimeout(r, 120));
    }

    console.log(`\n📊 [대조 검증 결과] 총 ${list.length}개 종목 중 일치: ${matchCount}개, 불일치: ${mismatchCount}개`);
    if (mismatchCount === 0 && list.length > 0) {
      console.log(`🎉 [SUCCESS] 단 하나의 오차도 없이 100% 전 종목이 KIS 원본 FHKST01010900 pbmn 수치와 완벽히 일치합니다!`);
    } else {
      console.error(`⚠️ [FAIL] 수치 불일치 또는 데이터 수신 실패 발생`);
    }
  }
}

verifyHttpRanking().catch(console.error);
