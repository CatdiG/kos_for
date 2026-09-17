import { NextRequest, NextResponse } from 'next/server';
import { fetchPrecursorSnapshots } from '@/lib/supabase';
import { InvestorRankingResponse, RankingItem } from '@/lib/types';

// 🎯 [기능 추가 - 사용자 요청: "전조 장마감" 탭] /api/stock/discovery와 동일 패턴 - 매일 14:40(KST)
// cron(compute-precursor-postmarket)이 미리 계산해 precursor_snapshots에 저장해둔 오늘자 결과만 읽는다.
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
    const rows = await fetchPrecursorSnapshots(date);
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
      type: 'precursor',
      recentReturnPct: r.recent_return_pct,
      volumeSurgeRatio: r.volume_surge_ratio,
      volumeTrendIncreasing: r.volume_trend_increasing,
      priceVolumeDivergence: r.price_volume_divergence,
      closeToHighRatioPct: r.close_to_high_ratio_pct,
      precursorScore: r.precursor_score,
    }));

    const response: InvestorRankingResponse = {
      type: 'precursor',
      direction: 'buy',
      period: '1d',
      list,
      isMock: false,
      updatedAt: new Date().toISOString(),
      lastBatchTime: list.length === 0 ? '아직 계산되지 않았습니다 (매 거래일 14:40 자동 계산)' : `${date.slice(4, 6)}/${date.slice(6, 8)} 14:40 기준`,
    };

    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    });
  } catch (error: any) {
    console.error('[API Precursor Error]', error);
    return NextResponse.json(
      { error: error?.message || '전조 장마감 데이터를 불러오는 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
