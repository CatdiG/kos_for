import { NextRequest, NextResponse, after } from 'next/server';
import { fetchKisForeignInstitutionRanking, fetchOverlapRankingData, fetchConsecutive3dOverlapRankingData, fetchKisInvestorTrend, getKisAccessTokenWithSource, resolveAndCacheMissingCredits, mergeCreditStatusToRanking, assertNoMockLeak } from '@/lib/kisApi';
import { getBatchRankingData, getBatchRankingDataAsync, runTop50BatchCollector } from '@/lib/batchCollector';
import { MarketType, RankingDirection, RankingPeriod, RankingType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60; // Set Vercel serverless function max duration to 60 seconds

export async function GET(request: NextRequest) {
  const routeStart = Date.now();
  const { searchParams } = new URL(request.url);
  const type = (searchParams.get('type') as RankingType) || 'foreign';
  const direction = (searchParams.get('direction') as RankingDirection) || 'buy';
  const period = (searchParams.get('period') as RankingPeriod) || '1d';
  const mode = searchParams.get('mode') || 'daily';
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const market = (searchParams.get('market') as MarketType) || 'ALL';

  console.log(`[PERF ROUTE START /api/stock/ranking] type=${type}, direction=${direction}, period=${period}, market=${market}`);

  try {
    let responseData: any;
    if (type === 'overlap') {
      if (mode === 'consecutive3d' || period === ('3d_consecutive' as any)) {
        responseData = await fetchConsecutive3dOverlapRankingData(direction, 2, limit, market);
      } else {
        responseData = await fetchOverlapRankingData(direction, period, 2, limit, market);
      }
    } else if (type === 'foreign' || type === 'organ') {
      responseData = await fetchKisForeignInstitutionRanking(type, direction, period, market, limit);
    } else if (type === 'pension' || type === 'program') {
      responseData = await getBatchRankingDataAsync(type, direction, period, market, limit);
      if (responseData && Array.isArray(responseData.list)) {
        responseData.list = await mergeCreditStatusToRanking(responseData.list);
      }
    } else {
      responseData = await fetchKisForeignInstitutionRanking('foreign', direction, period, market, limit);
    }

    assertNoMockLeak(responseData);

    let initialTrend: any = null;

    const instanceId = process.env.VERCEL_DEPLOYMENT_ID || `pid-${process.pid}`;
    const region = process.env.VERCEL_REGION || 'local-dev';
    const tokenInfo = await getKisAccessTokenWithSource();
    const elapsedMs = Date.now() - routeStart;
    console.log(`[PERF ROUTE END /api/stock/ranking] Total: ${elapsedMs}ms (Cache-Source: ${tokenInfo.source}, Instance: ${instanceId})`);

    // Next.js 15+ after() API: Keeps Vercel Serverless Function container awake to finish background batch collection
    if (typeof after === 'function') {
      after(async () => {
        if (responseData && Array.isArray(responseData.list)) {
          const missingSymbols = responseData.list
            .filter((item: any) => item.isCreditAvailable === undefined)
            .map((item: any) => item.symbol);
          if (missingSymbols.length > 0) {
            await resolveAndCacheMissingCredits(missingSymbols).catch(() => null);
          }
        }
        if (type === 'pension' || type === 'program' || type === 'overlap') {
          await runTop50BatchCollector(true, `after_batch_${type}`).catch(() => null);
        }
      });
    }

    return NextResponse.json(
      {
        ...responseData,
        initialTrend,
        perf: {
          routeTotalMs: elapsedMs,
          cacheSource: tokenInfo.source,
          instanceId,
          region,
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
          'X-Cache-Source': tokenInfo.source,
          'X-Instance-ID': instanceId,
          'X-Vercel-Region': region,
        },
      }
    );
  } catch (error: any) {
    const elapsedMs = Date.now() - routeStart;
    console.error(`[PERF ROUTE ERROR /api/stock/ranking] Failed after ${elapsedMs}ms:`, error);
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
