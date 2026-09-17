import { NextResponse } from 'next/server';
import { fetchWsWatchlist } from '@/lib/supabase';
import { fetchKisWatchlistQuotes } from '@/lib/kisApi';

// 🎯 [기능 추가 - 사용자 요청: "관심종목으로 누른 종목들 관심종목으로 따로 빼줘"] ws_watchlist(오라클
// 웹소켓 브릿지 구독 대상과 동일 목록)에 담긴 종목들의 실시간 현재가를 랭킹 화면 형식으로 반환한다.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const watchlist = await fetchWsWatchlist();
    const symbols = watchlist.map((w) => w.symbol);
    const list = await fetchKisWatchlistQuotes(symbols);

    return NextResponse.json(
      {
        type: 'watchlist',
        direction: 'buy',
        period: '1d',
        list,
        updatedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  } catch (error: any) {
    console.error('[API watchlist-ranking Error]', error);
    return NextResponse.json(
      { error: error?.message || '관심종목 데이터를 조회하는 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
