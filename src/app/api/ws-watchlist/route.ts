import { NextRequest, NextResponse } from 'next/server';
import { fetchWsWatchlist, addToWsWatchlist, removeFromWsWatchlist } from '@/lib/supabase';

// 🎯 [관심종목이 자주 바뀌는 문제 해결] 오라클 서버의 웹소켓 브릿지가 구독할 종목 목록을
// Supabase(ws_watchlist)로 관리한다 - 여기서 추가/삭제하면 브릿지가 30초마다 폴링해서 자동 반영한다.
export const dynamic = 'force-dynamic';

export async function GET() {
  const list = await fetchWsWatchlist();
  return NextResponse.json({ symbols: list });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const symbol = body?.symbol?.trim();
  const name = body?.name?.trim();
  if (!symbol) {
    return NextResponse.json({ error: 'symbol 파라미터가 필요합니다.' }, { status: 400 });
  }
  const ok = await addToWsWatchlist(symbol, name);
  if (!ok) {
    return NextResponse.json({ error: '관심종목 추가에 실패했습니다.' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol')?.trim();
  if (!symbol) {
    return NextResponse.json({ error: 'symbol 파라미터가 필요합니다.' }, { status: 400 });
  }
  const ok = await removeFromWsWatchlist(symbol);
  if (!ok) {
    return NextResponse.json({ error: '관심종목 삭제에 실패했습니다.' }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
