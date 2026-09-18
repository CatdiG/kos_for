import { NextRequest, NextResponse } from 'next/server';
import { pollReclaimWatchBatch } from '@/lib/kisApi';

// 🎯 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] VWAP 재돌파 감시 + 피봇(R1/R2) 재돌파 감시를
// 하나의 라우트로 합쳤다 - 예전엔 /api/stock/vwap-watch, /api/stock/pivot-watch가 따로 있어서 두
// 감시를 동시에 켜면 서로 다른 서버리스 함수가 같은 종목의 같은 순간 현재가를 KIS에 각자 물어보는
// 중복이 있었다(수칙 1-6, 두 기능이 항상 같은 종목 리스트·같은 15초 주기로 함께 쓰이므로 합치는 게
// 자연스럽다).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbolsParam = searchParams.get('symbols') || '';
  const symbols = symbolsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'symbols 파라미터가 필요합니다.' }, { status: 400 });
  }

  try {
    const results = await pollReclaimWatchBatch(symbols);
    return NextResponse.json(
      { results },
      { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  } catch (error: any) {
    console.error('[API reclaim-watch Error]', error);
    return NextResponse.json(
      { error: error?.message || 'VWAP/피봇 재돌파 감시 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
