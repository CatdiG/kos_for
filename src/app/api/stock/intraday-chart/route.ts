import { NextRequest, NextResponse } from 'next/server';
import { fetchKis3mCandlesFullDay } from '@/lib/kisApi';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  const timeUnit = (searchParams.get('timeUnit') as '3m') || '3m';

  if (!symbol || symbol.trim() === '') {
    return NextResponse.json(
      { error: 'symbol 파라미터가 필요합니다.' },
      { status: 400 }
    );
  }

  try {
    const data = await fetchKis3mCandlesFullDay(symbol.trim(), timeUnit);
    return NextResponse.json(data);
  } catch (error: any) {
    console.error(`[API /api/stock/intraday-chart Error] ${symbol}:`, error);
    return NextResponse.json(
      {
        error: error?.message || '3분봉 차트 데이터를 조회하는데 실패했습니다.',
        symbol,
      },
      { status: 500 }
    );
  }
}
