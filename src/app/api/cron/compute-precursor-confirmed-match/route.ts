import { NextRequest, NextResponse } from 'next/server';
import { fetchKisInvestorTrend } from '@/lib/kisApi';
import { fetchPrecursorSnapshots, updatePrecursorSnapshotsConfirmed } from '@/lib/supabase';

// 🎯 [실험 추가 - 사용자 지시: "가집계 vs 확정치 재현율 검증" 2단계, 2026-09-23] 14:40 크론
// (compute-precursor-postmarket)이 저장해 둔 가집계(foreign_ratio_estimate) 기준 오늘의 눌림후속
// 후보군에, 확정치(FHKST01010900)가 통상 입고되는 시각 이후 같은 심볼의 확정 외국인 순매수비율을
// 붙여서 "가집계 상위20% → 확정치도 상위20%였던 비율"을 자동 계산한다. collect-raw-daily-data 크론과
// 동일 근거로 18:30(KST)에 돈다(vercel.json) - 그보다 이르면 확정치가 아직 안 들어왔을 수 있다.
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
  return handleConfirmedMatch(request);
}

export async function POST(request: NextRequest) {
  return handleConfirmedMatch(request);
}

async function handleConfirmedMatch(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 확정치 매칭 계산 실행 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }
  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  if (authHeader !== expectedBearer && secretParam !== cronSecret.trim()) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패 (compute-precursor-confirmed-match)');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  try {
    const startedAt = Date.now();
    const date = todayYmdKst();
    const snapshots = await fetchPrecursorSnapshots(date);
    if (snapshots.length === 0) {
      return NextResponse.json({ success: true, date, message: '오늘 저장된 눌림후속 후보가 없습니다(14:40 크론 미실행 또는 후보 0건).', count: 0 });
    }

    // 종목별 확정 외국인 순매수비율 조회 - kisQueue가 이미 200ms 페이싱을 하므로 Promise.all로 넘긴다.
    const confirmedResults = await Promise.all(
      snapshots.map(async (snap) => {
        try {
          const trendRes = await fetchKisInvestorTrend(snap.symbol, '5d', 'LOW');
          const todayEntry = trendRes?.trend?.find((d) => d.date === date || d.stck_bsop_date === date);
          if (!todayEntry || !todayEntry.volume) return null;
          const isSettled = todayEntry.foreignNetBuyAmt !== 0 || todayEntry.organNetBuyAmt !== 0;
          if (!isSettled) return null; // 아직 확정치 미입고 - 가짜 0으로 채우지 않는다(수칙 1-3)
          return { symbol: snap.symbol, foreignRatioConfirmed: (todayEntry.foreignNetBuyQty / todayEntry.volume) * 100 };
        } catch {
          return null;
        }
      })
    );

    const withConfirmed = confirmedResults.filter((r): r is { symbol: string; foreignRatioConfirmed: number } => r !== null);
    const top20Count = Math.max(1, Math.ceil(withConfirmed.length * 0.2));
    const sorted = [...withConfirmed].sort((a, b) => b.foreignRatioConfirmed - a.foreignRatioConfirmed);
    const top20Symbols = new Set(sorted.slice(0, top20Count).map((r) => r.symbol));

    const updates = withConfirmed.map((r) => ({
      symbol: r.symbol,
      foreign_ratio_confirmed: Number(r.foreignRatioConfirmed.toFixed(3)),
      foreign_ratio_confirmed_top20: top20Symbols.has(r.symbol),
    }));
    const { updated, failed } = await updatePrecursorSnapshotsConfirmed(date, updates);

    // 적중률 계산: 가집계 상위20%였던 종목 중 확정치에서도 상위20%였던 비율
    const estimateTop20Symbols = new Set(snapshots.filter((s) => s.foreign_ratio_estimate_top20).map((s) => s.symbol));
    const confirmedTop20BySymbol = new Map(updates.map((u) => [u.symbol, u.foreign_ratio_confirmed_top20]));
    let bothTop20 = 0;
    let estimateTop20WithConfirmedData = 0;
    estimateTop20Symbols.forEach((symbol) => {
      if (confirmedTop20BySymbol.has(symbol)) {
        estimateTop20WithConfirmedData++;
        if (confirmedTop20BySymbol.get(symbol)) bothTop20++;
      }
    });
    const matchRatePct = estimateTop20WithConfirmedData > 0 ? Number(((bothTop20 / estimateTop20WithConfirmedData) * 100).toFixed(1)) : null;

    const elapsedMs = Date.now() - startedAt;
    console.log(`[전조(눌림후속) 확정치 매칭] ${date} - 후보 ${snapshots.length}개, 확정치 확보 ${withConfirmed.length}개, 가집계TOP20 ${estimateTop20Symbols.size}개 중 확정치도TOP20 ${bothTop20}개(적중률 ${matchRatePct}%), ${elapsedMs}ms 소요`);

    return NextResponse.json({
      success: true, date,
      totalCandidates: snapshots.length,
      confirmedFetched: withConfirmed.length,
      confirmedUpdated: updated,
      confirmedUpdateFailed: failed,
      estimateTop20Count: estimateTop20Symbols.size,
      estimateTop20WithConfirmedData,
      bothTop20Count: bothTop20,
      matchRatePct,
      elapsedMs,
    });
  } catch (error: any) {
    console.error('[전조(눌림후속) 확정치 매칭 오류]', error);
    return NextResponse.json({ error: error?.message || '확정치 매칭 계산 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
