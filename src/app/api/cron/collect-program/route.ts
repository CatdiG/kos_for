import { NextRequest, NextResponse } from 'next/server';
import { runTop50BatchCollector, getBatchRankingData } from '@/lib/batchCollector';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60; // 60s timeout for batch collection

export async function GET(request: NextRequest) {
  return handleCronBatch(request);
}

export async function POST(request: NextRequest) {
  return handleCronBatch(request);
}

async function handleCronBatch(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  // CRON_SECRET authorization check (보안 인증)
  if (cronSecret && cronSecret.trim() !== '') {
    const expectedBearer = `Bearer ${cronSecret.trim()}`;
    const isHeaderValid = authHeader === expectedBearer;
    const isParamValid = secretParam === cronSecret.trim();

    if (!isHeaderValid && !isParamValid) {
      console.warn('[Cron Auth Rejected] /api/cron/collect-program: CRON_SECRET 인증 실패');
      return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
    }
  }

  const startTime = Date.now();
  console.log('[CRON START /api/cron/collect-program] 300종목 프로그램 매매 정기 수집 시작');

  try {
    // force = true 로 300종목 강제 수집 및 캐시 갱신 실행
    const success = await runTop50BatchCollector(true, 'batch_program');
    const elapsedMs = Date.now() - startTime;

    const rankingData = getBatchRankingData('program', 'buy', '1d', 'ALL');
    const count = rankingData?.list ? rankingData.list.length : 0;

    console.log(`[CRON COMPLETE /api/cron/collect-program] 성공: ${success}, 수집종목수: ${count}, 소요시간: ${elapsedMs}ms`);

    return NextResponse.json({
      success,
      elapsedMs,
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
      count,
      asOfDateLabel: rankingData?.list?.[0]?.asOfDateLabel || '당일 가집계',
      top1Stock: rankingData?.list?.[0] ? `[${rankingData.list[0].symbol}] ${rankingData.list[0].name} (${rankingData.list[0].netBuyAmtEok}억)` : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    const elapsedMs = Date.now() - startTime;
    console.error(`[CRON ERROR /api/cron/collect-program] ${elapsedMs}ms 실패:`, error);
    return NextResponse.json(
      { error: error?.message || '프로그램 정기 수집 중 오류 발생' },
      { status: 500 }
    );
  }
}
