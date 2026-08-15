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

async function verifyAllRankingRawData() {
  console.log('=== KIS 원본 FHKST01010900 vs 랭킹 시스템 1:1 대조 및 Top 50 확장 검증 ===\n');

  // Dynamic import of ts-node/register or direct module execution
  require('ts-node/register');
  const { fetchKisForeignInstitutionRanking, getKisAccessToken } = require('../src/lib/kisApi.ts');

  const token = await getKisAccessToken();
  if (!token) {
    console.error('KIS Access Token 발급 실패');
    return;
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  const baseUrl = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

  // Helper to query raw FHKST01010900 directly
  async function fetchRawInvestorData(symbol) {
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

  // Test cases: Foreign Buy (Top 50), Organ Buy (Top 50)
  const testCases = [
    { type: 'foreign', direction: 'buy', label: '외국인 순매수 상위 (Top 50 확장)', limit: 50 },
    { type: 'organ', direction: 'buy', label: '기관 순매수 상위 (Top 50 확장)', limit: 50 },
  ];

  for (const testCase of testCases) {
    console.log(`\n========================================================================================`);
    console.log(`📌 [검증 대상] ${testCase.label} (요청 Limit: ${testCase.limit})`);
    console.log(`========================================================================================`);

    const rankingRes = await fetchKisForeignInstitutionRanking(testCase.type, testCase.direction, '1d', 'ALL', testCase.limit);
    const list = rankingRes.list || [];

    console.log(`수신된 총 종목 수: ${list.length}개\n`);
    console.log(`| 순위 | 종목코드 | 종목명 | 화면 순매수대금 | 화면 억원 | KIS 원본 pbmn | KIS 원본 억원 | 대조 결과 |`);
    console.log(`|---|---|---|---|---|---|---|---|`);

    let matchCount = 0;
    let mismatchCount = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const rawData = await fetchRawInvestorData(item.symbol);
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

      const statusTag = isMatch ? '✅ 일치 (100% 원본)' : '❌ 불일치';
      console.log(
        `| ${String(item.rank).padStart(2)}위 | ${item.symbol} | ${item.name.padEnd(12)} | ${item.netBuyAmt.toLocaleString().padStart(9)} 백만원 | ${String(item.netBuyAmtEok).padStart(6)} 억원 | ${rawPbmn.toLocaleString().padStart(9)} 백만원 | ${String(rawEok).padStart(6)} 억원 | ${statusTag} |`
      );

      // Brief delay between raw checks to avoid rate limit in verification loop
      await new Promise((r) => setTimeout(r, 120));
    }

    console.log(`\n📊 [검증 결과] 총 ${list.length}개 종목 중 일치: ${matchCount}개, 불일치: ${mismatchCount}개`);
    if (mismatchCount === 0) {
      console.log(`🎉 [SUCCESS] 모든 종목의 랭킹 수치가 KIS 원본 FHKST01010900 데이터와 1:1로 100% 완벽히 일치합니다!`);
    } else {
      console.error(`⚠️ [FAIL] ${mismatchCount}개 종목에서 수치 불일치가 발생했습니다.`);
    }
  }
}

verifyAllRankingRawData().catch(console.error);
