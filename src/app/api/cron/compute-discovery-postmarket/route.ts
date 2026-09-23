import { NextRequest, NextResponse } from 'next/server';
import { withCronRunLog } from '@/lib/cronRunLog';
import { fetchKisDiscoveryCandidates } from '@/lib/kisApi';
import { saveDiscoverySnapshots, DiscoverySnapshotRecord } from '@/lib/supabase';

// 🎯 [기능 추가 - 사용자 요청: "발굴 장마감" 탭] "장마감 후는 안되는데 한 2시30분~3시쯤 하면 안되나?
// 그걸 보고 내가 장마감때 사야하는거잖아" - 장마감(15:30) "전"에 계산해야 그날 종가 매수 판단에
// 쓸 수 있다. vercel.json에서 "30 5 * * 1-5"(UTC) = 매 거래일 14:30 KST에 호출한다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 280; // seed 260여 종목 중 상위 40개 종목별 최대 4회씩 조회 - 실측 여유 필요

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
  return withCronRunLog('compute-discovery-postmarket', request, () => handleComputeDiscovery(request));
}

export async function POST(request: NextRequest) {
  return withCronRunLog('compute-discovery-postmarket', request, () => handleComputeDiscovery(request));
}

async function handleComputeDiscovery(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 발굴 장마감 계산 실행 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }
  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  if (authHeader !== expectedBearer && secretParam !== cronSecret.trim()) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패 (compute-discovery-postmarket)');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  try {
    const startedAt = Date.now();
    const result = await fetchKisDiscoveryCandidates('ALL');
    const date = todayYmdKst();

    const records: DiscoverySnapshotRecord[] = result.list.map((item) => ({
      date,
      symbol: item.symbol,
      name: item.name,
      market: item.market || 'KOSPI',
      current_price: item.currentPrice,
      change_rate: item.changeRate,
      absorption_direction: item.absorptionDirection,
      absorption_badge: item.absorptionBadge,
      afternoon_volume_ratio_pct: item.afternoonVolumeRatioPct,
      volume_surge_ratio: item.volumeSurgeRatio,
      pullback_from_high_pct: item.pullbackFromHighPct,
      relative_strength_pct: item.relativeStrengthPct,
      discovery_score: item.discoveryScore,
      rank: item.rank,
    }));

    const saved = await saveDiscoverySnapshots(records);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[발굴 장마감 계산 완료] ${date} - ${records.length}종목, ${elapsedMs}ms 소요, 저장 ${saved ? '성공' : '실패'}`);

    return NextResponse.json({ success: true, date, count: records.length, elapsedMs, saved });
  } catch (error: any) {
    console.error('[발굴 장마감 계산 오류]', error);
    return NextResponse.json({ error: error?.message || '발굴 장마감 계산 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
