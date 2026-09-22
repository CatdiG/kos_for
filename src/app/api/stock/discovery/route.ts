import { NextRequest, NextResponse } from 'next/server';
import { fetchLatestDiscoverySnapshots } from '@/lib/supabase';
import { InvestorRankingResponse, RankingItem } from '@/lib/types';

// 🎯 [기능 추가 - 사용자 요청: "발굴 장마감" 탭] 매일 14:30(KST) cron(compute-discovery-postmarket)이
// 미리 계산해 discovery_snapshots에 저장해둔 결과를 읽는다 - 종목당 최대 4회 KIS 호출이 필요한
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

// 🚨 [버그 수정 - 사용자 지적: "장 끝나면 원래 있던게 다음 업데이트가 될때까지 남아 있어야지"] 예전엔
// "오늘 날짜"로만 고정 조회해서, 자정이 지나 날짜가 바뀌면 그날 14:30 크론이 돌기 전까지 무조건
// 빈 화면이었다(실측: 크론 자체는 매 거래일 정상 실행 중이었음). "가장 최근에 저장된 날짜"를 그대로
// 보여줘서 다음 계산 전까지 직전 결과가 유지되게 한다.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const market = searchParams.get('market') || 'ALL';

  try {
    const latest = await fetchLatestDiscoverySnapshots();
    const date = latest?.date || null;
    const rows = latest?.rows || [];
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

    // 🎯 [기능 추가 - 수칙 1-5: 대체 데이터 출처일 명시] date가 오늘이 아니면(아직 오늘자 계산 전이라
    // 직전 거래일 결과를 그대로 보여주는 중이면) "(N/N 기준)"으로 며칠자인지 명확히 밝힌다 - 어제
    // 결과를 오늘 결과인 것처럼 속여 보여주지 않는다.
    const isTodayResult = date === todayYmdKst();
    const dateLabel = date ? `${date.slice(4, 6)}/${date.slice(6, 8)}` : null;
    const lastBatchTime = !dateLabel
      ? '아직 계산되지 않았습니다 (매 거래일 14:30 자동 계산)'
      : isTodayResult
      ? `${dateLabel} 14:30 기준`
      : `${dateLabel} 14:30 기준 (다음 계산 전까지 최근 결과 유지 중)`;

    const response: InvestorRankingResponse = {
      type: 'discovery',
      direction: 'buy',
      period: '1d',
      list,
      isMock: false,
      updatedAt: new Date().toISOString(),
      lastBatchTime,
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
