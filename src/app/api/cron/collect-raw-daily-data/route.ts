import { NextRequest, NextResponse } from 'next/server';
import { TOP_300_STOCKS } from '@/lib/stockUniverse300';
import { runRawDailyDataBackfill } from '@/lib/batchCollector';

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
//
// 🚨 [실제 수집 로직 이동] 종목 순회/청크/upsert 로직 자체는 batchCollector.ts의
// runRawDailyDataBackfill로 옮겼다 - 이 라우트(HTTP+CRON_SECRET 인증 계층)뿐 아니라, 로컬처럼
// Vercel Cron이 아예 안 도는 환경에서 자동 자가치유하는 triggerRawDailyDataBackfillIfStale도
// 인증 계층 없이 인프로세스로 같은 로직을 재사용해야 하기 때문이다(수칙 1-6: 중복 구현 금지).
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300; // 5분 타임아웃 (archive-3m-candles와 동일한 상한)

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

  // 매 실행마다 최근 90영업일치를 통째로 다시 upsert한다(랭킹 배지 계산이 과거일 소스로 쓰는
  // DB_HISTORY_LOOKBACK_DAYS=90과 반드시 맞춰야 ma60까지 정상 계산되어 "바닥 반등" 등 60일선 기준
  // 배지가 차트와 동기화된다) - 이미 있는 날짜는 같은 값으로 덮어써도 무해하고, 빠진 날짜(로컬처럼
  // 며칠 못 돌았던 경우)는 자동으로 소급 채워진다.
  const result = await runRawDailyDataBackfill(startIdx, endIdx, 90);

  return NextResponse.json({
    success: true,
    total: endIdx - startIdx,
    rangeStart: startIdx,
    rangeEnd: endIdx,
    ...result,
  });
}
