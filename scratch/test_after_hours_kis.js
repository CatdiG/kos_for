require('dotenv').config({ path: '.env.local' });

const {
  fetchKisForeignInstitutionRanking,
  fetchKisSurgingStocks,
  fetchKisInvestorTrend,
} = require('../src/lib/kisApi');

async function testAfterHoursApis() {
  console.log('=== KIS API After-Hours Response Test ===');
  console.log('Current local time:', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));

  try {
    console.log('\n1. Testing fetchKisForeignInstitutionRanking (foreign buy 1d)...');
    const rankingRes = await fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', 'ALL', 5);
    console.log('Ranking success! Total items received:', rankingRes?.list?.length);
    if (rankingRes?.list?.length > 0) {
      console.log('Top 3 ranking items:');
      rankingRes.list.slice(0, 3).forEach((item) => {
        console.log(`  [${item.rank}위] ${item.name} (${item.symbol}): ${item.currentPrice}원, 등락률 ${item.changeRate}%, 순매수 ${item.netBuyAmtEok}억원`);
      });
    }
  } catch (err) {
    console.error('Ranking API failed:', err.message);
  }

  try {
    console.log('\n2. Testing fetchKisSurgingStocks (fluctuation ALL)...');
    const surgingRes = await fetchKisSurgingStocks('fluctuation', 'ALL');
    console.log('Surging success! Total items received:', surgingRes?.list?.length);
    if (surgingRes?.list?.length > 0) {
      console.log('Top 3 surging items:');
      surgingRes.list.slice(0, 3).forEach((item) => {
        console.log(`  [${item.rank}위] ${item.name} (${item.symbol}): ${item.currentPrice}원, 등락률 ${item.changeRate}%`);
      });
    }
  } catch (err) {
    console.error('Surging API failed:', err.message);
  }

  try {
    console.log('\n3. Testing fetchKisInvestorTrend (삼성전자 005930)...');
    const trendRes = await fetchKisInvestorTrend('005930', '20d');
    console.log('Trend success! Stock:', trendRes?.stockInfo?.name, trendRes?.stockInfo?.currentPrice, '원');
    console.log('Trend daily points count:', trendRes?.trend?.length);
    if (trendRes?.trend?.length > 0) {
      const latestDay = trendRes.trend[trendRes.trend.length - 1];
      console.log('Latest day data point:', latestDay.date, '종가:', latestDay.closePrice, '외인순매수:', latestDay.foreignNetBuyAmt, '백만원');
    }
  } catch (err) {
    console.error('Trend API failed:', err.message);
  }
}

testAfterHoursApis();
