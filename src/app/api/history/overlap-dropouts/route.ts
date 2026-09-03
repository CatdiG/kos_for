import { NextRequest, NextResponse } from 'next/server';
import { calculateOverlapDropoutsFromHistory, normalizeDate, HistoryQueryParams } from '@/lib/historyService';
import { RankingDirection, MarketType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const date = searchParams.get('date') || '2026-08-28';
  const direction = (searchParams.get('direction') || 'buy') as RankingDirection;
  const market = (searchParams.get('market') || 'ALL') as MarketType;
  const targetDaysRaw = parseInt(searchParams.get('targetDays') || '2', 10);
  const targetDays: 2 | 3 = targetDaysRaw === 3 ? 3 : 2;

  try {
    const normalizedDate = normalizeDate(date);
    const params: HistoryQueryParams = { date, type: 'overlap', direction, market };
    const result = await calculateOverlapDropoutsFromHistory(normalizedDate, params, targetDays);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' },
    });
  } catch (error: any) {
    console.error('[History Overlap Dropouts API Error]', error);
    return NextResponse.json(
      { error: error?.message || '이탈 종목 데이터를 조회하는 중 오류가 발생했습니다.', list: [] },
      { status: 500 }
    );
  }
}
