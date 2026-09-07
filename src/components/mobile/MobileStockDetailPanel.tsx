'use client';

// 종목 상세(전 탭 뱃지 + 수급 요약 카드 + 캔들 차트)를 보여주는 공통 패널 - symbol 하나만 받으면
// 스스로 investor-trend를 조회해 완결적으로 렌더링한다. MobileStockSearch.tsx(검색 결과 아래)와
// MobileRankingList.tsx(랭킹 카드를 탭했을 때 그 카드 바로 아래, 데스크톱 InvestorRankingTable.tsx의
// expandedSymbols 아코디언과 동일 패턴)가 이 컴포넌트를 그대로 재사용한다 - 종목 상세를 그리는 로직을
// 두 곳에 중복 작성하지 않기 위해 분리했다(수칙 1-6).

import { useQuery } from '@tanstack/react-query';
import { InvestorTrendResponse } from '@/lib/types';
import SupplySummaryCards from '@/components/SupplySummaryCards';
import StockBadgeStrip from '@/components/StockBadgeStrip';
import MobileStockDetailChart from './MobileStockDetailChart';

async function fetchInvestorTrend(symbol: string): Promise<InvestorTrendResponse> {
  const res = await fetch(`/api/stock/investor-trend?symbol=${symbol}&period=60d`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '수급 데이터를 가져오는 중 오류가 발생했습니다.');
  }
  return res.json();
}

export default function MobileStockDetailPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery<InvestorTrendResponse>({
    queryKey: ['investorTrend', symbol, '60d'],
    queryFn: () => fetchInvestorTrend(symbol),
    enabled: Boolean(symbol),
  });

  return (
    <div className="w-full flex flex-col gap-3">
      {/* 전 탭 뱃지 모음 - 데스크톱 StockBadgeStrip.tsx를 그대로 재사용(수칙 1-6). 뱃지가 없으면
          컴포넌트 자체가 null을 반환해 아무것도 렌더링되지 않으므로(:empty), 감싸는 카드도 함께 숨긴다. */}
      <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-2 empty:hidden empty:border-0 empty:p-0">
        <StockBadgeStrip symbol={symbol} />
      </div>
      <SupplySummaryCards
        summary={data?.summary}
        programTrade={data?.programTrade}
        stockInfo={data?.stockInfo}
        isLoading={isLoading || !data}
      />
      <MobileStockDetailChart trend={data?.trend || []} stockInfo={data?.stockInfo} isLoading={isLoading || !data} />
    </div>
  );
}
