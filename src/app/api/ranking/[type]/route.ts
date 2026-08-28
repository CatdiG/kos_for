import { NextRequest, NextResponse } from 'next/server';
import { fetchKisForeignInstitutionRanking, fetchOverlapRankingData, fetchConsecutive2dOverlapRankingData, fetchConsecutive3dOverlapRankingData } from '@/lib/kisApi';
import { getBatchRankingData, getBatchRankingDataAsync } from '@/lib/batchCollector';
import { MarketType, RankingDirection, RankingPeriod, RankingType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type: pathType } = await params;
  const { searchParams } = new URL(request.url);

  const type = (pathType || searchParams.get('type') || 'foreign') as RankingType;
  const direction = (searchParams.get('direction') as RankingDirection) || 'buy';
  const period = (searchParams.get('period') as RankingPeriod) || '1d';
  const mode = searchParams.get('mode') || 'daily';
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const market = (searchParams.get('market') as MarketType) || 'ALL';

  try {
    let responseData: any;
    if (type === 'overlap') {
      if (mode === 'consecutive2d' || period === 'consecutive2d') {
        responseData = await fetchConsecutive2dOverlapRankingData(direction, 2, limit, market);
      } else if (mode === 'consecutive3d' || period === ('3d_consecutive' as any) || period === 'consecutive3d') {
        responseData = await fetchConsecutive3dOverlapRankingData(direction, 2, limit, market);
      } else {
        responseData = await fetchOverlapRankingData(direction, period as any, 2, limit, market);
      }
    } else if (type === 'foreign' || type === 'organ') {
      const reqPeriod = (period === 'consecutive2d' || period === 'consecutive3d') ? '1d' : (period as '1d' | '1w' | '1m');
      responseData = await fetchKisForeignInstitutionRanking(type, direction, reqPeriod, market, limit);
    } else if (type === 'pension' || type === 'program') {
      const reqPeriod = (period === 'consecutive2d' || period === 'consecutive3d') ? '1d' : (period as '1d' | '1w' | '1m');
      responseData = await getBatchRankingDataAsync(type, direction, reqPeriod, market);
    } else {
      responseData = await fetchKisForeignInstitutionRanking('foreign', direction, '1d', market, limit);
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error) {
    console.error('[Ranking API [type] Exception]', error);
    return NextResponse.json(
      { error: '매매 순위 데이터를 가져오는 중 오류가 발생했습니다.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}
