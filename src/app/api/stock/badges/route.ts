import { NextRequest, NextResponse } from 'next/server';
import { getStockBadgeSummary } from '@/lib/kisApi';
import { getStockName } from '@/lib/mockData';
import { MarketType, StockBadgeSummaryResponse } from '@/lib/types';

// 종목 검색 옆 "전 탭 뱃지 모음" 전용 라우트 - 새 KIS 라이브 호출 없이 각 탭의 기존 캐시만 훑어보므로
// 항상 빠르다(수 ms). 캐시가 비어있는 탭은 결과에서 그냥 빠진다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 10;

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
