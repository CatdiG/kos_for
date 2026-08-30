import { NextResponse } from 'next/server';
import { runTop50BatchCollector, getBatchRankingDataAsync } from '@/lib/batchCollector';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 최대 5분 타임아웃 지원

/**
 * 개발 전용 수동 연기금 300종목 배치 트리거 엔드포인트
 * GET /api/dev/trigger-pension-batch
 */
export async function GET(request: Request) {
  const startTime = Date.now();
  console.log('🚀 [Dev Manual Trigger] 연기금 300종목 수집 배치 수동 실행 시작');

  try {
    // 295개 종목(TOP_300_STOCKS) 강제 수집 실행
    const success = await runTop50BatchCollector(true, 'batch_pension');
    const elapsedMs = Date.now() - startTime;
    const elapsedSeconds = Number((elapsedMs / 1000).toFixed(2));

    // 최신화된 캐시 데이터 확인
    const latestData = await getBatchRankingDataAsync('pension', 'buy', '1d', 'ALL');
    const list = latestData.list || [];
    const top1 = list[0] ? `[${list[0].symbol}] ${list[0].name} (${list[0].netBuyAmtEok}억)` : '없음';

    return NextResponse.json({
      success,
      message: '개발 전용 연기금 300종목 수집 배치가 성공적으로 완료되었습니다.',
      elapsedMs,
      elapsedSeconds,
      count: list.length,
      asOfDateLabel: latestData.asOfDateLabel,
      top1Stock: top1,
      updatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('❌ [Dev Manual Trigger Error]', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || '개발 전용 배치 실행 중 오류 발생',
        elapsedMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
