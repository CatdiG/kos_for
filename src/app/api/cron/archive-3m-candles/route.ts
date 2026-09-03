import { NextRequest, NextResponse } from 'next/server';
import { fetchKis3mCandlesFullDay, listLocalTodayViewed3mSymbols } from '@/lib/kisApi';
import { TOP_300_STOCKS } from '@/lib/stockUniverse300';
import { listIntraday3mCandleStatusForDate } from '@/lib/supabase';

// 장마감(15:30 KST) 직후 실행되는 3분봉 EOD(End of Day) 아카이빙 크론.
//
// 🚨 [수칙 1-1 진단 후 확장] 예전엔 TOP_50_STOCKS(50종목)만 대상이라, 검색으로 열어본 TOP_300 밖의
// 종목(예: 004310 - KIS 전체 상장 3,554종목 마스터에는 있지만 큐레이션 295종목엔 없음)은 "어제 130개
// 완전체"를 절대 가질 수 없었다. 이제 두 그룹을 합쳐서 아카이빙한다:
//   (1) TOP_300_STOCKS (295종목) - collect-raw-daily-data 크론과 동일한 큐레이션 유니버스
//   (2) 오늘 실제로 한 번이라도 조회되어 부분저장(save3mCandlesToDiskAsync)이 찍힌 심볼 중 (1)에
//       없는 것 - Supabase(intraday_3m_candles)와 로컬 디스크를 함께 스캔해서 찾는다.
// 종목당 API 호출이 14회(30분 슬롯별)라 raw_daily_data 크론(종목당 1회)보다 훨씬 무겁다 - 295종목을
// 한 크론에 다 넣으면 300초 제한을 크게 초과하므로, startIdx/endIdx로 구간을 나눠 vercel.json에서
// 여러 크론으로 시간차 호출한다(collect-raw-daily-data와 동일한 청크 분할 패턴).
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getKstTodayStr(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  return `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;
}

/**
 * 오늘 아카이빙할 전체 대상 심볼 목록을 구성한다: TOP_300_STOCKS + 오늘 조회된 TOP_300 밖 추가 종목.
 * 완전 미달(130개 미만) 여부와 무관하게 일단 후보에는 다 넣는다 - 이미 완전체인 종목을 다시 받아도
 * upsert라 손해가 없고, "오늘 조회했지만 아직 부분저장만 된" 종목을 놓치지 않는 게 더 중요하다.
 */
async function buildTargetSymbolList(): Promise<Array<{ symbol: string; name: string }>> {
  const today = getKstTodayStr();
  const curated = TOP_300_STOCKS.map((s) => ({ symbol: s.symbol, name: s.name }));
  const curatedSet = new Set(curated.map((s) => s.symbol));

  const [dbViewed, localViewed] = await Promise.all([
    listIntraday3mCandleStatusForDate(today).catch(() => []),
    Promise.resolve(listLocalTodayViewed3mSymbols(today)),
  ]);

  const extraSymbols = new Set<string>();
  [...dbViewed, ...localViewed].forEach(({ symbol }) => {
    if (symbol && !curatedSet.has(symbol)) extraSymbols.add(symbol);
  });

  const extra = [...extraSymbols].map((symbol) => ({ symbol, name: symbol }));
  return [...curated, ...extra];
}

export async function GET(request: NextRequest) {
  return handleArchive3mCandles(request);
}

export async function POST(request: NextRequest) {
  return handleArchive3mCandles(request);
}

async function handleArchive3mCandles(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  // Strict Vercel Cron Header / CRON_SECRET authorization check (refresh-kis-token과 동일 패턴)
  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 3분봉 아카이빙 실행 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }

  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  const isHeaderValid = authHeader === expectedBearer;
  const isParamValid = secretParam === cronSecret.trim();

  if (!isHeaderValid && !isParamValid) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  const fullTargetList = await buildTargetSymbolList();

  // 295종목(+오늘 조회 추가분)을 종목당 14회 API 호출로 한 크론에서 다 처리하면 300초 제한을 크게
  // 넘기므로, raw_daily_data 크론과 동일하게 startIdx/endIdx 쿼리 파라미터로 구간을 나눠 처리한다.
  const startIdxParam = url.searchParams.get('startIdx');
  const endIdxParam = url.searchParams.get('endIdx');
  const startIdx = startIdxParam ? Math.max(0, parseInt(startIdxParam, 10)) : 0;
  const endIdx = endIdxParam ? Math.min(fullTargetList.length, parseInt(endIdxParam, 10)) : fullTargetList.length;
  const targetList = fullTargetList.slice(startIdx, endIdx);

  const startedAt = Date.now();
  const succeeded: string[] = [];
  const failed: Array<{ symbol: string; error: string }> = [];

  console.log(`[3m Candles EOD Archive] 시작 - 전체 대상 ${fullTargetList.length}종목(큐레이션 ${TOP_300_STOCKS.length} + 오늘 추가조회 ${fullTargetList.length - TOP_300_STOCKS.length}) 중 [${startIdx}, ${endIdx}) 구간 ${targetList.length}종목 처리`);

  // KIS 순간 레이트리밋(EGW00201) 방지를 위해 종목 간 순차 처리 + 간격 확보
  // (fetchKis3mCandlesFullDay 내부적으로 종목당 최대 14개 슬롯을 동시에 조회하므로,
  //  종목끼리는 겹치지 않게 하나씩 처리한다)
  for (const stock of targetList) {
    try {
      await fetchKis3mCandlesFullDay(stock.symbol, '3m');
      succeeded.push(stock.symbol);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`[3m Candles EOD Archive Failed] ${stock.symbol}(${stock.name}): ${msg}`);
      failed.push({ symbol: stock.symbol, error: msg });
    }
    await sleep(400);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[3m Candles EOD Archive] 완료 - 성공 ${succeeded.length}/${targetList.length}, 실패 ${failed.length}건, 소요 ${elapsedMs}ms`);

  return NextResponse.json({
    success: true,
    fullTotal: fullTargetList.length,
    curatedTotal: TOP_300_STOCKS.length,
    extraTodayViewedTotal: fullTargetList.length - TOP_300_STOCKS.length,
    rangeStart: startIdx,
    rangeEnd: endIdx,
    total: targetList.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    failed,
    elapsedMs,
  });
}
