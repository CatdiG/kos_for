import { NextRequest, NextResponse } from 'next/server';
import { fetchDiscoverySnapshots } from '@/lib/supabase';
import { InvestorRankingResponse, RankingItem } from '@/lib/types';

// 🎯 [기능 추가 - 사용자 요청: "발굴 장마감" 탭] 매일 14:30(KST) cron(compute-discovery-postmarket)이
// 미리 계산해 discovery_snapshots에 저장해둔 오늘자 결과만 읽는다 - 종목당 최대 4회 KIS 호출이 필요한
// 무거운 계산이라 페이지 방문마다 재계산하지 않는다(수칙 2-6과 동일 취지 - 겉핥기 200 OK가 아니라
// 실제로 비용을 감당할 수 있는 구조인지 확인하고 설계함).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  const { searchParams } = new URL(request.url);
  const market = searchParams.get('market') || 'ALL';
  const date = todayYmdKst();

  try {
    const rows = await fetchDiscoverySnapshots(date);
    const filtered = market === 'ALL' ? rows : rows.filter((r) => r.market === market);

    const list: RankingItem[] = filtered.map((r) => ({
      rank: r.rank || 0,
      symbol: r.symbol,
      name: r.name,
      market: r.market,
      currentPrice: r.current_price,
      change: 0,
      changeRate: r.change_rate,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume: 0,
      ratioVsVolume: 0,
      type: 'discovery',
      absorptionDirection: r.absorption_direction as any,
      absorptionBadge: r.absorption_badge,
      afternoonVolumeRatioPct: r.afternoon_volume_ratio_pct,
      volumeSurgeRatio: r.volume_surge_ratio,
      pullbackFromHighPct: r.pullback_from_high_pct,
      relativeStrengthPct: r.relative_strength_pct,
      discoveryScore: r.discovery_score,
    }));

    const response: InvestorRankingResponse = {
      type: 'discovery',
      direction: 'buy',
      period: '1d',
      list,
      isMock: false,
      updatedAt: new Date().toISOString(),
      lastBatchTime: list.length === 0 ? '아직 계산되지 않았습니다 (매 거래일 14:30 자동 계산)' : `${date.slice(4, 6)}/${date.slice(6, 8)} 14:30 기준`,
    };

    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    });
  } catch (error: any) {
    console.error('[API Discovery Error]', error);
    return NextResponse.json(
      { error: error?.message || '발굴 장마감 데이터를 불러오는 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
