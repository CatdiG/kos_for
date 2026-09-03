'use client';

// 종목 검색 위에 표시되는 KOSPI/KOSDAQ 지수 요약 카드 2개. 클릭하면 IndexDetailChart가 열린다.

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { IndexTrendResponse } from '@/lib/types';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface IndexCardsProps {
  selected: 'KOSPI' | 'KOSDAQ' | null;
  onSelect: (market: 'KOSPI' | 'KOSDAQ') => void;
}

async function fetchIndexSummary(market: 'KOSPI' | 'KOSDAQ'): Promise<IndexTrendResponse> {
  // 카드는 현재가/등락률만 표시하므로 일봉 배열이 필요 없다 - summaryOnly로 KIS 호출을 절반(2회→1회)으로 줄인다.
  const res = await fetch(`/api/stock/index-trend?market=${market}&period=5d&summaryOnly=1`);
  if (!res.ok) throw new Error('지수 조회 실패');
  return res.json();
}

function IndexCard({ market, selected, onSelect }: { market: 'KOSPI' | 'KOSDAQ' } & IndexCardsProps) {
  const { data, isLoading } = useQuery<IndexTrendResponse>({
    queryKey: ['indexSummary', market],
    queryFn: () => fetchIndexSummary(market),
    refetchInterval: 30 * 1000,
  });

  const info = data?.indexInfo;
  const isUp = (info?.change || 0) >= 0;
  const isActive = selected === market;

  return (
    <button
      onClick={() => onSelect(market)}
      className={`flex-1 flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition text-left cursor-pointer ${
        isActive
          ? 'bg-white dark:bg-[#1e222d] border-red-500/60 shadow-md ring-1 ring-red-500/30'
          : 'bg-white/70 dark:bg-[#131722]/70 border-slate-200 dark:border-[#2a2e39] hover:bg-white dark:hover:bg-[#1e222d]'
      }`}
    >
      <div>
        <div className="text-xs font-bold text-slate-500 dark:text-[#787b86]">{market === 'KOSPI' ? '코스피' : '코스닥'}</div>
        {isLoading || !info ? (
          <div className="text-lg font-mono font-bold text-slate-300 dark:text-[#3a3f4b]">-</div>
        ) : (
          <div className="text-lg font-mono font-bold text-slate-900 dark:text-white">{info.currentPrice.toLocaleString()}</div>
        )}
      </div>
      {info && (
        <div className={`flex items-center gap-1 text-xs font-semibold font-mono ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
          {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          <span>{isUp ? '+' : ''}{info.change.toFixed(2)} ({isUp ? '+' : ''}{info.changeRate.toFixed(2)}%)</span>
        </div>
      )}
    </button>
  );
}

export default function IndexCards({ selected, onSelect }: IndexCardsProps) {
  return (
    <div className="flex items-stretch gap-2.5">
      <IndexCard market="KOSPI" selected={selected} onSelect={onSelect} />
      <IndexCard market="KOSDAQ" selected={selected} onSelect={onSelect} />
    </div>
  );
}
