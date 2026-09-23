import { NextRequest, NextResponse } from 'next/server';
import { fetchLatestPrecursorSnapshots } from '@/lib/supabase';
import { InvestorRankingResponse, RankingItem } from '@/lib/types';
import { mergeCreditStatusToRanking } from '@/lib/kisApi';

// 🎯 [기능 추가 - 사용자 요청: "전조 장마감" 탭] /api/stock/discovery와 동일 패턴 - 매일 14:40(KST)
// cron(compute-precursor-postmarket)이 미리 계산해 precursor_snapshots에 저장해둔 결과를 읽는다.
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

// 🚨 [버그 수정 - discovery/route.ts와 동일 원인·동일 수정(수칙 1-6)] "오늘 날짜" 고정 조회 대신
// "가장 최근에 저장된 날짜"를 그대로 보여줘서, 자정이 지난 뒤 그날 14:40 크론이 돌기 전까지도 직전
// 결과가 유지되게 한다.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const market = searchParams.get('market') || 'ALL';

  try {
    const latest = await fetchLatestPrecursorSnapshots();
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
      type: 'precursor',
      closeToHighRatioPct: r.close_to_high_ratio_pct,
      foreignRatioEstimate: r.foreign_ratio_estimate,
      foreignRatioEstimateTop20: r.foreign_ratio_estimate_top20,
      foreignRatioEstimateRankPct: r.foreign_ratio_estimate_rank_pct,
    }));

    // 🚨 [버그 수정 - 사용자 지적: "장마감 후보군 신용데이터는 다 똑같은걸 쓸텐데 왜 신용이 되는지
    // 안되는지 안뜨냐고"] discovery/route.ts와 동일 원인·동일 수정(수칙 1-6) - 이미 있는 공용 함수
    // mergeCreditStatusToRanking(kis_credits 테이블)을 그대로 재사용한다.
    const listWithCredit = await mergeCreditStatusToRanking(list);

    const isTodayResult = date === todayYmdKst();
    const dateLabel = date ? `${date.slice(4, 6)}/${date.slice(6, 8)}` : null;
    const lastBatchTime = !dateLabel
      ? '아직 계산되지 않았습니다 (매 거래일 14:40 자동 계산)'
      : isTodayResult
      ? `${dateLabel} 14:40 기준`
      : `${dateLabel} 14:40 기준 (다음 계산 전까지 최근 결과 유지 중)`;

    const response: InvestorRankingResponse = {
      type: 'precursor',
      direction: 'buy',
      period: '1d',
      list: listWithCredit,
      isMock: false,
      updatedAt: new Date().toISOString(),
      lastBatchTime,
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
