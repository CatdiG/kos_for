import { NextRequest, NextResponse } from 'next/server';
import { fetchKisPostMarketCandidates } from '@/lib/kisApi';
import { savePostmarketSnapshots, PostmarketSnapshotRecord } from '@/lib/supabase';

// 🎯 [기능 추가 - 사용자 지적: "급등 장마감은 실시간이랑 히스토리랑 종목 맞지도 않아. 3번은 2번으로
// 수정해"] discovery/precursor 크론과 동일 패턴(수칙 1-6) - 라이브 탭이 쓰는 함수
// (fetchKisPostMarketCandidates)를 그대로 한 번 호출해 그 결과를 영구 저장한다. 새 계산 로직을 만들지
// 않고 실시간과 완전히 동일한 함수를 재사용하므로, 히스토리가 이 스냅샷을 읽기만 하면 실시간=히스토리가
// 원천적으로 같은 소스가 된다. vercel.json에서 "45 6 * * 1-5"(UTC) = 매 거래일 15:45 KST(정규장
// 마감 15:30 이후, 후보군 지표가 더 이상 안 바뀌는 시점)에 호출한다.
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
  return handleComputePostmarket(request);
}

export async function POST(request: NextRequest) {
  return handleComputePostmarket(request);
}

async function handleComputePostmarket(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 급등 장마감 스냅샷 저장 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }
  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  if (authHeader !== expectedBearer && secretParam !== cronSecret.trim()) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패 (compute-postmarket-snapshot)');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  try {
    const startedAt = Date.now();
    const result = await fetchKisPostMarketCandidates('ALL');
    const date = todayYmdKst();

    const records: PostmarketSnapshotRecord[] = result.list.map((item) => ({
      date,
      symbol: item.symbol,
      name: item.name,
      market: item.market || 'KOSPI',
      current_price: item.currentPrice,
      change_rate: item.changeRate,
      volume: item.volume,
      amount_eok: item.amountEok,
      overlap_count: item.overlapCount,
      surging_modes: item.surgingModes,
      surging_ranks: item.surgingRanks,
      surging_badge: item.surgingBadge,
      today_range_pct: item.todayRangePct,
      close_position_pct: item.closePositionPct,
      post_market_score: item.postMarketScore,
      foreign_supply_badge: item.foreignSupplyBadge,
      organ_supply_badge: item.organSupplyBadge,
      rank: item.rank,
    }));

    const saved = await savePostmarketSnapshots(records);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[급등 장마감 스냅샷 저장 완료] ${date} - ${records.length}종목, ${elapsedMs}ms 소요, 저장 ${saved ? '성공' : '실패'}`);

    return NextResponse.json({ success: true, date, count: records.length, elapsedMs, saved });
  } catch (error: any) {
    console.error('[급등 장마감 스냅샷 저장 오류]', error);
    return NextResponse.json({ error: error?.message || '급등 장마감 스냅샷 저장 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
