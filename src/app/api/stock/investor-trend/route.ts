import { NextRequest, NextResponse } from 'next/server';
import { fetchKisInvestorTrend } from '@/lib/kisApi';
import { TrendPeriod } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const routeStart = Date.now();
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '005930';
  const periodParam = (searchParams.get('period') || '20d') as TrendPeriod;

  const validPeriods: TrendPeriod[] = ['5d', '20d', '60d'];
  const period: TrendPeriod = validPeriods.includes(periodParam) ? periodParam : '20d';

  console.log(`[PERF ROUTE START /api/stock/investor-trend] symbol=${symbol}, period=${period}`);

  try {
    const data = await fetchKisInvestorTrend(symbol, period);
    const elapsedMs = Date.now() - routeStart;
    console.log(`[PERF ROUTE END /api/stock/investor-trend] Total: ${elapsedMs}ms`);

    return NextResponse.json(
      {
        ...data,
        perf: { routeTotalMs: elapsedMs },
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  } catch (error: any) {
    const elapsedMs = Date.now() - routeStart;
    console.error(`[PERF ROUTE ERROR /api/stock/investor-trend] Failed after ${elapsedMs}ms:`, error);
    return NextResponse.json(
      { error: error?.message || '주식 수급 데이터를 불러오는 도중 오류가 발생했습니다.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}
