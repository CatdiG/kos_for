import { NextRequest, NextResponse } from 'next/server';
import { fetchConsecutiveOverlapDropouts, fetchYesterdayOverlapDropouts } from '@/lib/kisApi';
import { MarketType, RankingDirection } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const direction = (searchParams.get('direction') as RankingDirection) || 'buy';
  const market = (searchParams.get('market') as MarketType) || 'ALL';
  const targetDays = parseInt(searchParams.get('targetDays') || '2', 10);
  // scope=today(기본, 당일 하루 안의 변화) | scope=yesterday(직전 영업일 마감 대비 - 히스토리 페이지와 동일 기준)
  const scope = (searchParams.get('scope') || 'today') as 'today' | 'yesterday';

  try {
    if (scope === 'yesterday') {
      const list = await fetchYesterdayOverlapDropouts(direction, market, targetDays);
      return NextResponse.json(
        { list, targetDays, direction, market, scope },
        { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
      );
    }

    const list = await fetchConsecutiveOverlapDropouts(direction, market, targetDays);
    return NextResponse.json(
      { list, targetDays, direction, market, scope },
      { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  } catch (error: any) {
    console.error('[API consecutive-overlap-dropouts Error]', error);
    return NextResponse.json(
      { error: error?.message || '이탈 종목 데이터를 가져오는 중 오류가 발생했습니다.', list: [] },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  }
}
