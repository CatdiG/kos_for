import { NextRequest, NextResponse } from 'next/server';
import { getHistoryRankingData, HistoryQueryParams } from '@/lib/historyService';
import { RankingType, RankingDirection, RankingPeriod, MarketType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const date = searchParams.get('date') || '2026-08-28';
  const type = (searchParams.get('type') || 'foreign') as RankingType;
  const direction = (searchParams.get('direction') || 'buy') as RankingDirection;
  const period = (searchParams.get('period') || '1d') as RankingPeriod;
  const market = (searchParams.get('market') || 'ALL') as MarketType;
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const mode = searchParams.get('mode') as any;
  const surgingMode = searchParams.get('surgingMode') as any;

  try {
    const params: HistoryQueryParams = {
      date,
      type,
      direction,
      period,
      market,
      limit,
      mode,
      surgingMode,
    };

    const data = await getHistoryRankingData(params);

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch (error: any) {
    console.error('[History API Error]', error);
    return NextResponse.json(
      { error: error?.message || '과거 랭킹 데이터를 조회하는 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
