import { NextRequest, NextResponse, after } from 'next/server';
import { fetchKisForeignInstitutionRanking, fetchOverlapRankingData, fetchConsecutive2dOverlapRankingData, fetchConsecutive3dOverlapRankingData, fetchKisQuietAccumulationCandidates, fetchKisInvestorTrend, getKisAccessTokenWithSource, resolveAndCacheMissingCredits, mergeCreditStatusToRanking, assertNoMockLeak } from '@/lib/kisApi';
import { getBatchRankingDataAsync } from '@/lib/batchCollector';
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
  // 🚨 [기능 재설계 - 사용자 요청: "토글 필터로 진행해줘"] 예전엔 mode='supplyPostmarket'이라는 별도
  // 4번째 탭이었지만, 지금은 당일/2일연속/3일연속 중 어느 탭이든 위에 얹을 수 있는 독립된 토글이라
  // mode(기준 탭)와 별개의 쿼리 파라미터로 분리했다(수칙 1-6 - 탭 종류만큼 mode 값을 늘리지 않음).
  const quietFilter = searchParams.get('quietFilter') === '1';

  console.log(`[PERF ROUTE START /api/stock/ranking] type=${type}, direction=${direction}, period=${period}, market=${market}`);

  try {
    let responseData: any;
    if (type === 'overlap') {
      // 🚨 [기능 재설계 - "장마감 후보만" 토글] 실측 백테스트(kisApi.ts의 applyQuietAccumulationFilter
      // 주석 참고)로 검증한 역발상 점수를, 지금 보고 있는 기준 탭(당일/2일연속/3일연속) 그대로 유지한 채
      // 얹는다 - 기준 탭 판별 로직 자체는 바로 아래 분기와 동일해야 하므로 한 곳에서 baseMode로 정리한다.
      const baseMode: 'daily' | 'consecutive2d' | 'consecutive3d' =
        mode === 'consecutive2d' || period === 'consecutive2d'
          ? 'consecutive2d'
          : mode === 'consecutive3d' || period === ('3d_consecutive' as any) || period === 'consecutive3d'
          ? 'consecutive3d'
          : 'daily';

      if (quietFilter) {
        responseData = await fetchKisQuietAccumulationCandidates(baseMode, direction, market, limit);
      } else if (baseMode === 'consecutive2d') {
        responseData = await fetchConsecutive2dOverlapRankingData(direction, 2, limit, market);
      } else if (baseMode === 'consecutive3d') {
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
        // 🎯 [구조 변경 2026-09-23] 예전엔 program 탭 응답 뒤 여기서 runTop50BatchCollector로 300종목을 다시
        // 수집했다(새 값은 "다음 조회자"에게만 보였음). 이제 수집은 오라클 상시 수집기가 2~3분마다 하고 웹은
        // Supabase 캐시만 읽는다(batchCollector.ts getBatchRankingDataAsync) - 여기서 KIS를 부르지 않는다.
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
