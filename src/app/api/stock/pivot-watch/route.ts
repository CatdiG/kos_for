import { NextRequest, NextResponse } from 'next/server';
import { pollPivotWatchBatch } from '@/lib/kisApi';

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
    const results = await pollPivotWatchBatch(symbols);
    return NextResponse.json(
      { results },
      { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  } catch (error: any) {
    console.error('[API pivot-watch Error]', error);
    return NextResponse.json(
      { error: error?.message || '피봇 재돌파 감시 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
