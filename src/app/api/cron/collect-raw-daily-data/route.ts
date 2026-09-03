import { NextRequest, NextResponse } from 'next/server';
import { fetchKisInvestorTrend, fetchKisProgramTradeDaily } from '@/lib/kisApi';
import { TOP_300_STOCKS } from '@/lib/stockUniverse300';
import { saveRawDailyDataToSupabase, RawDailyInvestorRecord } from '@/lib/supabase';

// 장마감 확정치 반영 후(18:30 KST) 자동 실행되는 raw_daily_data 아카이빙 크론.
// 지금까지 raw_daily_data는 scratch/collect_raw_daily_data_v2.js를 사람이 손으로 실행해야만
// 채워졌다(자동 크론 없음 - saveRawDailyDataToSupabase를 호출하는 곳이 코드 전체에 없었음).
// 이 크론이 매 거래일 저녁 TOP_300_STOCKS 295종목의 "당일 확정" 수급 데이터를 raw_daily_data에
// upsert해서, 히스토리(/history)뿐 아니라 향후 라이브 앱의 2/3일연속 계산도 이 DB를 과거일자
// 소스로 재사용할 수 있게 한다. (vercel.json의 crons 스케줄에서 호출)
//
// 15:35(archive-3m-candles와 동시)가 아니라 18:30으로 잡은 이유:
// kisApi.ts의 fetchKisInvestorTrend/executeKisInvestorTrendFetch를 보면 장마감 직후에도
// 외국인/기관 순매수 확정치(FHKST01010900)가 바로 입고되지 않아 isTodaySettled=false인 채로
// 14:30 잠정치를 대신 쓰는 구간이 있다(kisApi.ts:812-827). 15:35에 수집하면 미확정 0값을
// 영구 저장할 위험이 있어, 확정치가 통상 반영되는 18:30으로 여유를 두었다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300; // 5분 타임아웃 (archive-3m-candles와 동일한 상한)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest) {
  return handleCollectRawDailyData(request);
}

export async function POST(request: NextRequest) {
  return handleCollectRawDailyData(request);
}

async function handleCollectRawDailyData(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  // Strict Vercel Cron Header / CRON_SECRET authorization check (archive-3m-candles와 동일 패턴)
  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 raw_daily_data 수집 실행 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }

  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  const isHeaderValid = authHeader === expectedBearer;
  const isParamValid = secretParam === cronSecret.trim();

  if (!isHeaderValid && !isParamValid) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패 (collect-raw-daily-data)');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  // 295종목을 한 번에 다 처리하면 kisQueue(300ms 최소 간격) 특성상 실측 274.9초가 걸려
  // maxDuration=300초 상한에 너무 바짝 붙는다(로컬 실측 증빙). 그래서 startIdx/endIdx 쿼리
  // 파라미터로 대상 종목 구간을 나눠 처리할 수 있게 하고, vercel.json에서 두 번의 크론(시간차)으로
  // 나눠 호출한다. 파라미터가 없으면(로컬 수동 테스트 등) 전체 종목을 대상으로 한다.
  const startIdxParam = url.searchParams.get('startIdx');
  const endIdxParam = url.searchParams.get('endIdx');
  const startIdx = startIdxParam ? Math.max(0, parseInt(startIdxParam, 10)) : 0;
  const endIdx = endIdxParam ? Math.min(TOP_300_STOCKS.length, parseInt(endIdxParam, 10)) : TOP_300_STOCKS.length;
  const targetList = TOP_300_STOCKS.slice(startIdx, endIdx);

  const startedAt = Date.now();
  const records: RawDailyInvestorRecord[] = [];
  const unsettled: string[] = []; // 외인/기관 둘 다 0 (확정치 미입고로 추정) - 저장은 하되 별도 보고
  const failed: string[] = [];

  console.log(`[Raw Daily Data Cron] 시작 - 대상 ${targetList.length}종목 (전체 ${TOP_300_STOCKS.length}종목 중 [${startIdx}, ${endIdx}) 구간)`);

  // KIS 순간 레이트리밋(EGW00201) 방지: fetchKisInvestorTrend는 전역 kisQueue를 타지만
  // fetchKisProgramTradeDaily는 큐를 타지 않으므로, 청크 단위로 나누고 청크 사이에 딜레이를 둔다.
  const CHUNK_SIZE = 5;
  const CHUNK_DELAY_MS = 250;

  for (let i = 0; i < targetList.length; i += CHUNK_SIZE) {
    const chunk = targetList.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (stock) => {
        try {
          const trendRes = await fetchKisInvestorTrend(stock.symbol, '5d', 'LOW');
          const latestDay = trendRes?.trend?.[trendRes.trend.length - 1];
          if (!latestDay || !latestDay.date) {
            failed.push(stock.symbol);
            return;
          }

          const progPoints = await fetchKisProgramTradeDaily(stock.symbol).catch(() => []);
          const progMatch = progPoints.find((p) => p.date === latestDay.date);

          const isSettled = latestDay.foreignNetBuyAmt !== 0 || latestDay.organNetBuyAmt !== 0;
          if (!isSettled) unsettled.push(stock.symbol);

          records.push({
            date: latestDay.date,
            symbol: stock.symbol,
            name: stock.name,
            close_price: latestDay.closePrice,
            open_price: latestDay.openPrice,
            high_price: latestDay.highPrice,
            low_price: latestDay.lowPrice,
            volume: latestDay.volume,
            change_rate: latestDay.changeRate,
            foreign_net_buy_qty: latestDay.foreignNetBuyQty,
            foreign_net_buy_amt: latestDay.foreignNetBuyAmt,
            organ_net_buy_qty: latestDay.organNetBuyQty,
            organ_net_buy_amt: latestDay.organNetBuyAmt,
            program_net_buy_qty: progMatch?.totalNetBuyQty || 0,
            program_net_buy_amt: progMatch?.totalNetBuyAmt || 0,
          });
        } catch (err: any) {
          console.warn(`[Raw Daily Data Cron Failed] ${stock.symbol}(${stock.name}): ${err?.message || err}`);
          failed.push(stock.symbol);
        }
      })
    );
    await sleep(CHUNK_DELAY_MS);
  }

  const saved = records.length > 0 ? await saveRawDailyDataToSupabase(records) : false;
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[Raw Daily Data Cron] 완료 - 수집 ${records.length}/${TOP_300_STOCKS.length}, 실패 ${failed.length}건, 미확정(0값) ${unsettled.length}건, Supabase 저장: ${saved}, 소요 ${elapsedMs}ms`
  );

  return NextResponse.json({
    success: true,
    total: targetList.length,
    rangeStart: startIdx,
    rangeEnd: endIdx,
    collectedCount: records.length,
    failedCount: failed.length,
    unsettledCount: unsettled.length,
    unsettledSymbols: unsettled.slice(0, 20),
    failedSymbols: failed.slice(0, 20),
    saved,
    elapsedMs,
    date: records[0]?.date || null,
  });
}
