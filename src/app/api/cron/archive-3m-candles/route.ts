import { NextRequest, NextResponse } from 'next/server';
import {
  fetchKis3mCandlesFullDay,
  listLocalTodayViewed3mSymbols,
  fetchKisForeignInstitutionRanking,
  fetchKisSurgingStocks,
  fetchOverlapRankingData,
} from '@/lib/kisApi';
import { TOP_300_STOCKS } from '@/lib/stockUniverse300';
import { listIntraday3mCandleStatusForDate } from '@/lib/supabase';

// 장마감(15:30 KST) 직후 실행되는 3분봉 EOD(End of Day) 아카이빙 크론.
//
// 🚨 [수칙 1-1 진단 후 확장] 예전엔 TOP_50_STOCKS(50종목)만 대상이라, 검색으로 열어본 TOP_300 밖의
// 종목(예: 004310 - KIS 전체 상장 3,554종목 마스터에는 있지만 큐레이션 295종목엔 없음)은 "어제 130개
// 완전체"를 절대 가질 수 없었다. 이제 세 그룹을 합쳐서 아카이빙한다:
//   (1) TOP_300_STOCKS (295종목) - collect-raw-daily-data 크론과 동일한 큐레이션 유니버스
//   (2) 오늘 실제로 한 번이라도 조회되어 부분저장(save3mCandlesToDiskAsync)이 찍힌 심볼 중 (1)에
//       없는 것 - Supabase(intraday_3m_candles)와 로컬 디스크를 함께 스캔해서 찾는다.
//   (3) [신규] 오늘 외국인/기관/프로그램/급등주/수급교집합 상위권에 뜬 종목 중 (1)에 없는 것 - 사용자가
//       실제로 클릭해서 본 적이 없어도(예: 핵토파이낸셜 234340 - 정상 거래인데 TOP_300 밖이라 아무도
//       안 열어봤으면 (2)로도 못 잡혔음, 실측으로 확인된 사례) 그날 눈에 띄게 거래된 종목은 자동으로
//       포함시켜 "어제 3분봉이 15:00부터만 있고 앞부분이 통째로 빔" 문제를 근본적으로 줄인다.
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
// 카테고리별 상위 몇 종목까지 "오늘 랭킹권" 추가 대상으로 볼지 - 너무 크게 잡으면 대상 목록이
// vercel.json에 고정된 청크 범위(마지막 구간 endIdx)를 넘어서서 뒤쪽 종목이 그 어느 구간에도 안 걸려
// 영영 처리 안 되는 문제가 생긴다. 카테고리 7개 × 30개 = 최대 210개 후보지만, 카테고리끼리도 겹치고
// TOP_300과도 많이 겹쳐서(둘 다 "눈에 띄는" 종목 위주라) 실제 신규 추가분은 이보다 훨씬 적다.
const RANKED_EXTRA_CAP_PER_CATEGORY = 30;

/**
 * [신규] 오늘 외국인/기관/프로그램/급등주/수급교집합 상위권에 뜬 종목을 모은다. 전부 이미 자체 TTL
 * 캐시를 갖고 있는 "요약형" 함수라(종목별 반복 조회 없음), 이 목적으로 호출해도 비용이 작다 - 뱃지
 * 모음 기능(getStockBadgeSummary)에서 이미 검증된 것과 동일한 함수/패턴을 재사용한다. 하나가 실패해도
 * 나머지 카테고리 수집에 영향 없도록 개별적으로 방어한다.
 */
async function fetchTodayRankedExtraSymbols(): Promise<Set<string>> {
  const market = 'ALL' as const;
  const symbols = new Set<string>();

  const addTop = (list: Array<{ symbol: string }> | undefined) => {
    (list || []).slice(0, RANKED_EXTRA_CAP_PER_CATEGORY).forEach((item) => {
      if (item.symbol) symbols.add(item.symbol);
    });
  };

  const [foreignBuy, foreignSell, organBuy, organSell, surgingFluc, overlapBuy, overlapSell] = await Promise.all([
    fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', market, 50).catch(() => null),
    fetchKisForeignInstitutionRanking('foreign', 'sell', '1d', market, 50).catch(() => null),
    fetchKisForeignInstitutionRanking('organ', 'buy', '1d', market, 50).catch(() => null),
    fetchKisForeignInstitutionRanking('organ', 'sell', '1d', market, 50).catch(() => null),
    fetchKisSurgingStocks('fluctuation', market).catch(() => null),
    fetchOverlapRankingData('buy', '1d', 2, 50, market).catch(() => null),
    fetchOverlapRankingData('sell', '1d', 2, 50, market).catch(() => null),
  ]);
  [foreignBuy, foreignSell, organBuy, organSell, surgingFluc, overlapBuy, overlapSell].forEach((res) => addTop(res?.list));

  // 프로그램 순매수·순매도 - batchCollector의 캐시 peek(라이브 호출 아님, 캐시 없으면 그냥 건너뜀)
  try {
    const { getBatchRankingData } = await import('@/lib/batchCollector');
    (['buy', 'sell'] as const).forEach((direction) => {
      addTop(getBatchRankingData('program', direction, '1d', market).list);
    });
  } catch (_) {}

  return symbols;
}

async function buildTargetSymbolList(): Promise<Array<{ symbol: string; name: string }>> {
  const today = getKstTodayStr();
  const curated = TOP_300_STOCKS.map((s) => ({ symbol: s.symbol, name: s.name }));
  const curatedSet = new Set(curated.map((s) => s.symbol));

  const [dbViewed, localViewed, rankedExtra] = await Promise.all([
    listIntraday3mCandleStatusForDate(today).catch(() => []),
    Promise.resolve(listLocalTodayViewed3mSymbols(today)),
    fetchTodayRankedExtraSymbols().catch(() => new Set<string>()),
  ]);

  const extraSymbols = new Set<string>();
  [...dbViewed, ...localViewed].forEach(({ symbol }) => {
    if (symbol && !curatedSet.has(symbol)) extraSymbols.add(symbol);
  });
  rankedExtra.forEach((symbol) => {
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
