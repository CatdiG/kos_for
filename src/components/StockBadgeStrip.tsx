'use client';

// 종목 검색창과 종목명/가격 표시 사이의 빈 공간에, 지금 이 종목이 현재 존재하는 모든 랭킹 탭(급등주/
// 단타종합랭킹/외국인/기관/프로그램/수급교집합 당일·2일연속·3일연속)의 어디에 떠 있는지 한 줄로 모아
// 보여준다. 뱃지 문구/스타일은 각 탭에서 이미 쓰던 것을 그대로 재사용한다(새로 디자인하지 않음).

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { StockBadgeSummaryResponse } from '@/lib/types';

interface StockBadgeStripProps {
  symbol: string;
}

async function fetchStockBadges(symbol: string): Promise<StockBadgeSummaryResponse> {
  const res = await fetch(`/api/stock/badges?symbol=${symbol}&market=ALL`);
  if (!res.ok) throw new Error('뱃지 조회 실패');
  return res.json();
}

const DEFAULT_BADGE_STYLE = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700';

// 수급교집합 탭의 주체별 연속매매 뱃지 - HistoryRankingTable/InvestorRankingTable과 동일한 매수/매도 배색
function entityBadgeColor(netBuyAmt: number) {
  return netBuyAmt >= 0
    ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/50'
    : 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-900/50';
}

export default function StockBadgeStrip({ symbol }: StockBadgeStripProps) {
  const { data } = useQuery<StockBadgeSummaryResponse>({
    queryKey: ['stockBadges', symbol],
    queryFn: () => fetchStockBadges(symbol),
    enabled: Boolean(symbol),
    staleTime: 20 * 1000,
    refetchInterval: 30 * 1000,
  });

  const badges = data?.badges || [];
  if (badges.length === 0) return null;

  return (
    // 🚨 [UI 수정] flex-1 하나로 옆 종목명 블록(shrink-0 없음)까지 밀어붙이던 걸,
    // 오른쪽에 명시적 여백(mr-3)을 둬서 뱃지가 아무리 여러 줄로 늘어나도 종목명 영역을 침범하지 않게 한다.
    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 px-1 lg:px-3 mr-3 lg:mr-4">
      {badges.map((b) => (
        <span
          key={b.tabId}
          title={`${b.tabLabel} ${b.rank}위${b.investorBadge ? ` · ${b.investorBadge}` : ''}`}
          className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap ${
            b.statusBadgeStyle || DEFAULT_BADGE_STYLE
          }`}
        >
          <span className="opacity-70 font-medium">{b.tabLabel}</span>
          <span>{b.rank}위</span>
          {b.aiPickRank && b.aiPickRank <= 5 && <span title={`AI 수급 추천 ${b.aiPickRank}위`}>⭐</span>}

          {/* 수급교집합 탭은 주체별 실제 연속일수 뱃지를 그대로 붙여서 보여준다 */}
          {Array.isArray(b.ranksByType) && b.ranksByType.length > 0 && (
            <span className="flex items-center gap-0.5 ml-0.5">
              {b.ranksByType.map((r) => (
                <span
                  key={r.type}
                  className={`px-1 py-0.5 rounded border text-[9px] font-mono ${entityBadgeColor(r.netBuyAmt)}`}
                >
                  {r.label} {r.consecutiveText || '당일'}
                </span>
              ))}
            </span>
          )}

          {/* 급등주 교집합 전용 문구 */}
          {b.surgingBadge && <span className="opacity-80">{b.surgingBadge}</span>}

          {/* 단타 종합랭킹 점수 */}
          {typeof b.scoreTotal === 'number' && <span className="opacity-80">{b.scoreTotal}점</span>}
        </span>
      ))}
    </div>
  );
}
