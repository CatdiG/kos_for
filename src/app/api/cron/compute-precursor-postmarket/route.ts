import { NextRequest, NextResponse } from 'next/server';
import { fetchKisPrecursorCandidates } from '@/lib/kisApi';
import { savePrecursorSnapshots, PrecursorSnapshotRecord } from '@/lib/supabase';

// 🎯 [기능 추가 - 사용자 요청: "전조 장마감" 탭] "발굴 장마감"과 동일 이유로 장마감(15:30) "전"에
// 계산한다. vercel.json에서 "40 5 * * 1-5"(UTC) = 매 거래일 14:40 KST에 호출 - 발굴 장마감(14:30)과
// 10분 텀을 둬서 두 크론이 동시에 KIS를 때리지 않게 한다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 280;

function todayYmdKst(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export async function GET(request: NextRequest) {
  return handleComputePrecursor(request);
}

export async function POST(request: NextRequest) {
  return handleComputePrecursor(request);
}

async function handleComputePrecursor(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 전조 장마감 계산 실행 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }
  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  if (authHeader !== expectedBearer && secretParam !== cronSecret.trim()) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패 (compute-precursor-postmarket)');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  try {
    const startedAt = Date.now();
    const result = await fetchKisPrecursorCandidates('ALL');
    const date = todayYmdKst();

    const records: PrecursorSnapshotRecord[] = result.list.map((item) => ({
      date,
      symbol: item.symbol,
      name: item.name,
      market: item.market || 'KOSPI',
      current_price: item.currentPrice,
      change_rate: item.changeRate,
      close_to_high_ratio_pct: item.closeToHighRatioPct,
      rank: item.rank,
      // 🎯 [실험 추가 - "가집계 vs 확정치 재현율 검증" 1단계, 2026-09-23]
      foreign_ratio_estimate: item.foreignRatioEstimate,
      foreign_ratio_estimate_top20: item.foreignRatioEstimateTop20,
      foreign_ratio_estimate_rank_pct: item.foreignRatioEstimateRankPct,
    }));

    const saved = await savePrecursorSnapshots(records);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[전조 장마감 계산 완료] ${date} - ${records.length}종목, ${elapsedMs}ms 소요, 저장 ${saved ? '성공' : '실패'}`);

    return NextResponse.json({ success: true, date, count: records.length, elapsedMs, saved });
  } catch (error: any) {
    console.error('[전조 장마감 계산 오류]', error);
    return NextResponse.json({ error: error?.message || '전조 장마감 계산 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
