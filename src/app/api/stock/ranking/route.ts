import { NextRequest, NextResponse, after } from 'next/server';
import { fetchKisForeignInstitutionRanking, fetchOverlapRankingData, fetchConsecutive2dOverlapRankingData, fetchConsecutive3dOverlapRankingData, fetchKisInvestorTrend, getKisAccessTokenWithSource, resolveAndCacheMissingCredits, mergeCreditStatusToRanking, assertNoMockLeak } from '@/lib/kisApi';
import { getBatchRankingData, getBatchRankingDataAsync, runTop50BatchCollector } from '@/lib/batchCollector';
import { MarketType, RankingDirection, RankingPeriod, RankingType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// 🚨 [버그 수정] 60초였던 예전 값이 실측으로 확인된 근본 원인이었다 - 수급교집합(당일/2일/3일연속)은
// 콜드스타트 시 종목별 라이브 KIS 조회가 여러 건 필요해 60초를 넘기는 경우가 실제로 있었는데, Vercel이
// 정확히 60초에 FUNCTION_INVOCATION_TIMEOUT(504)으로 함수를 강제 종료해버렸다(재현: 버셀 배포 URL에
// 당일교집합 요청 시 60.37초에 504). Hobby 플랜도 최대 300초까지 지원하므로 여유 있게 늘린다.
export const maxDuration = 280;

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
    } else if (type === 'program') {
      const reqPeriod = (period === 'consecutive2d' || period === 'consecutive3d') ? '1d' : (period as '1d' | '1w' | '1m');
      responseData = await getBatchRankingDataAsync('program', direction, reqPeriod, market, limit);
      if (responseData && Array.isArray(responseData.list)) {
        responseData.list = await mergeCreditStatusToRanking(responseData.list);
      }
    } else {
      responseData = await fetchKisForeignInstitutionRanking('foreign', direction, '1d', market, limit);
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
        if (type === 'program') {
          await runTop50BatchCollector(false, `after_batch_${type}`).catch(() => null);
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
