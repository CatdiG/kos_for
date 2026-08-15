import { NextRequest, NextResponse } from 'next/server';
import { fetchKisInvestorTrend } from '@/lib/kisApi';
import { TrendPeriod } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '005930';
  const periodParam = (searchParams.get('period') || '20d') as TrendPeriod;

  const validPeriods: TrendPeriod[] = ['5d', '20d', '60d'];
  const period: TrendPeriod = validPeriods.includes(periodParam) ? periodParam : '20d';

  try {
    const data = await fetchKisInvestorTrend(symbol, period);
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error: any) {
    console.error('[API Route Error]', error);
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
