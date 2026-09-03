import { NextRequest, NextResponse } from 'next/server';
import { getStockBadgeSummary } from '@/lib/kisApi';
import { getStockName } from '@/lib/mockData';
import { MarketType, StockBadgeSummaryResponse } from '@/lib/types';

// 종목 검색 옆 "전 탭 뱃지 모음" 전용 라우트.
// 🚨 [버그 수정] "새 KIS 라이브 호출 없이 각 탭의 기존 캐시만 훑어본다"던 원래 설계는 Vercel
// 프로덕션에서 실측으로 거의 항상 비어있는 결과를 반환하는 게 확인됐다 - Vercel은 API 라우트마다
// 별도 서버리스 컨테이너(별도 프로세스)로 뜨는 경우가 있어서, 방금 /api/stock/ranking을 호출해
// rankingCacheStore를 채워도 바로 이어진 /api/stock/badges 요청은 완전히 다른 컨테이너라 그 메모리를
// 전혀 못 봤다(실측: 삼성중공업 외국인 순매수 1위 조회 직후 뱃지 조회 결과가 badges:[]). getStockBadgeSummary가
// 이제 무거운 2일/3일연속 교집합만 빼고 나머지는 직접 라이브 호출로 이 컨테이너 자신의 캐시를 그 자리에서
// 채우도록 바뀌어서, 콜드 컨테이너에서는 예전(10초)보다 시간이 더 걸릴 수 있어 여유 있게 상향한다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || '';
  const market = (searchParams.get('market') as MarketType) || 'ALL';

  if (!symbol) {
    return NextResponse.json({ error: 'symbol 파라미터가 필요합니다.' }, { status: 400 });
  }

  try {
    const badges = await getStockBadgeSummary(symbol, market);
    const data: StockBadgeSummaryResponse = {
      symbol,
      name: getStockName(symbol),
      badges,
      updatedAt: new Date().toISOString(),
    };
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    });
  } catch (error: any) {
    console.error('[API Stock Badges Error]', error);
    return NextResponse.json(
      { error: error?.message || '종목 뱃지 정보를 불러오는 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
