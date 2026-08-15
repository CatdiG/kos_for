import { NextRequest, NextResponse } from 'next/server';
import { fetchKisForeignInstitutionRanking, fetchOverlapRankingData, fetchConsecutive3dOverlapRankingData } from '@/lib/kisApi';
import { getBatchRankingData } from '@/lib/batchCollector';
import { MarketType, RankingDirection, RankingPeriod, RankingType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60; // Set Vercel serverless function max duration to 60 seconds

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = (searchParams.get('type') as RankingType) || 'foreign';
  const direction = (searchParams.get('direction') as RankingDirection) || 'buy';
  const period = (searchParams.get('period') as RankingPeriod) || '1d';
  const mode = searchParams.get('mode') || 'daily';
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const market = (searchParams.get('market') as MarketType) || 'ALL';

  try {
    let responseData: any;
    if (type === 'overlap') {
      if (mode === 'consecutive3d' || period === ('3d_consecutive' as any)) {
        responseData = await fetchConsecutive3dOverlapRankingData(direction, 2, limit, market);
      } else {
        responseData = await fetchOverlapRankingData(direction, period, 2, limit, market);
      }
    } else if (type === 'foreign' || type === 'organ') {
      responseData = await fetchKisForeignInstitutionRanking(type, direction, period, market);
    } else if (type === 'pension' || type === 'program') {
      responseData = getBatchRankingData(type, direction, period, market);
    } else {
      responseData = await fetchKisForeignInstitutionRanking('foreign', direction, period, market);
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error: any) {
    console.error('[Ranking API Route Exception]', error);
    return NextResponse.json(
      { error: error?.message || '매매순위 수급 데이터를 가져오는 중 오류가 발생했습니다.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}
