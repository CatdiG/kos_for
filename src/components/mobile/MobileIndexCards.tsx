'use client';

// 데스크톱 IndexCards.tsx의 모바일판 - 코스피/코스닥을 가로로 나란히 두면 375px 화면에서 잘려나가는
// 문제(오늘 Browser 도구로 실측 확인)를 세로로 쌓아서 해결한다. 데이터 소스는 기존 API를 그대로 쓴다
// (수칙 1-6, 새 엔드포인트 불필요) - IndexCards.tsx의 fetchIndexSummary와 동일한 요청.
// 🚨 [기능 추가] Phase 1에서는 비대화형이었으나, MobileIndexDetailChart 연결에 맞춰 데스크톱
// IndexCards.tsx와 동일하게 탭하면 선택 상태가 되도록 selected/onSelect props를 추가한다.

import { useQuery } from '@tanstack/react-query';
import { IndexTrendResponse } from '@/lib/types';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface MobileIndexCardsProps {
  selected: 'KOSPI' | 'KOSDAQ' | null;
  onSelect: (market: 'KOSPI' | 'KOSDAQ') => void;
}

async function fetchIndexSummary(market: 'KOSPI' | 'KOSDAQ'): Promise<IndexTrendResponse> {
  const res = await fetch(`/api/stock/index-trend?market=${market}&period=5d&summaryOnly=1`);
  if (!res.ok) throw new Error('지수 조회 실패');
  return res.json();
}

function MobileIndexCard({ market, selected, onSelect }: { market: 'KOSPI' | 'KOSDAQ' } & MobileIndexCardsProps) {
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
      className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition text-left ${
        isActive
          ? 'bg-white dark:bg-[#1e222d] border-red-500/60 shadow-md ring-1 ring-red-500/30'
          : 'bg-white dark:bg-[#131722] border-slate-200 dark:border-[#2a2e39]'
      }`}
    >
      <div className="text-xs font-bold text-slate-500 dark:text-[#787b86] shrink-0 w-12">
        {market === 'KOSPI' ? '코스피' : '코스닥'}
      </div>
      {isLoading || !info ? (
        <div className="flex-1 text-right text-lg font-mono font-bold text-slate-300 dark:text-[#3a3f4b]">-</div>
      ) : (
        <>
          <div className="flex-1 text-right text-lg font-mono font-bold text-slate-900 dark:text-white">
            {info.currentPrice.toLocaleString()}
          </div>
          <div className={`flex items-center gap-1 text-xs font-semibold font-mono shrink-0 ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
            {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            <span>{isUp ? '+' : ''}{info.change.toFixed(2)} ({isUp ? '+' : ''}{info.changeRate.toFixed(2)}%)</span>
          </div>
        </>
      )}
    </button>
  );
}

export default function MobileIndexCards({ selected, onSelect }: MobileIndexCardsProps) {
  return (
    <div className="flex flex-col gap-2">
      <MobileIndexCard market="KOSPI" selected={selected} onSelect={onSelect} />
      <MobileIndexCard market="KOSDAQ" selected={selected} onSelect={onSelect} />
    </div>
  );
}
