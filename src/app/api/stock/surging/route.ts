import { NextRequest, NextResponse, after } from 'next/server';
import { fetchKisSurgingStocks, fetchKisInvestorTrend, resolveAndCacheMissingCredits, mergeCreditStatusToRanking } from '@/lib/kisApi';
import { MarketType, SurgingMode } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const modeParam = (searchParams.get('mode') || 'fluctuation') as SurgingMode;
  const market = (searchParams.get('market') as MarketType) || 'ALL';
  // 🎯 [기능 추가 - 사용자 요청: "셀렉터까지 원해"] 급등주 교집합에서 몇 개 지표(등락률·거래량·거래대금)
  // 이상 겹쳐야 노출할지 - 값이 없거나 1~3 범위 밖이면 기존 동작(2)으로 안전하게 되돌린다.
  const minOverlapParam = parseInt(searchParams.get('minOverlap') || '2', 10);
  const minOverlap = [1, 2, 3].includes(minOverlapParam) ? minOverlapParam : 2;

  const validModes: SurgingMode[] = ['fluctuation', 'volume', 'amount', 'overlap', 'comprehensive', 'postmarket'];
  const mode: SurgingMode = validModes.includes(modeParam) ? modeParam : 'fluctuation';

  try {
    const data = await fetchKisSurgingStocks(mode, market, minOverlap);
    if (data && Array.isArray(data.list)) {
      data.list = await mergeCreditStatusToRanking(data.list);
    }
    let initialTrend: any = null;

    if (data && Array.isArray(data.list)) {
      const missingSymbols = data.list
        .filter((item: any) => item.isCreditAvailable === undefined)
        .map((item: any) => item.symbol);
      if (missingSymbols.length > 0) {
        after(async () => {
          await resolveAndCacheMissingCredits(missingSymbols);
        });
      }
    }

    return NextResponse.json(
      {
        ...data,
        initialTrend,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  } catch (error: any) {
    console.error('[API Surging Error]', error);
    return NextResponse.json(
      { error: error?.message || '급등주 순위 데이터를 불러오는 도중 오류가 발생했습니다.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}
