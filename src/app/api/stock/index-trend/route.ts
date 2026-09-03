import { NextRequest, NextResponse } from 'next/server';
import { fetchKisIndexDailyTrend } from '@/lib/kisApi';
import { TrendPeriod } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const routeStart = Date.now();
  const { searchParams } = new URL(request.url);
  const marketParam = (searchParams.get('market') || 'KOSPI').toUpperCase();
  const market = marketParam === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const periodParam = (searchParams.get('period') || '60d') as TrendPeriod;
  const validPeriods: TrendPeriod[] = ['5d', '20d', '60d'];
  const period: TrendPeriod = validPeriods.includes(periodParam) ? periodParam : '60d';
  // 코스피/코스닥 카드(요약용)는 현재가만 필요해 일봉 조회를 생략하는 경량 모드
  const summaryOnly = searchParams.get('summaryOnly') === '1' || searchParams.get('summaryOnly') === 'true';

  console.log(`[PERF ROUTE START /api/stock/index-trend] market=${market}, period=${period}, summaryOnly=${summaryOnly}`);

  try {
    const data = await fetchKisIndexDailyTrend(market, period, summaryOnly);
    const elapsedMs = Date.now() - routeStart;
    console.log(`[PERF ROUTE END /api/stock/index-trend] Total: ${elapsedMs}ms`);

    return NextResponse.json(
      { ...data, perf: { routeTotalMs: elapsedMs } },
      { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  } catch (error: any) {
    const elapsedMs = Date.now() - routeStart;
    console.error(`[PERF ROUTE ERROR /api/stock/index-trend] Failed after ${elapsedMs}ms:`, error);
    return NextResponse.json(
      { error: error?.message || '지수 데이터를 불러오는 도중 오류가 발생했습니다.' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  }
}
