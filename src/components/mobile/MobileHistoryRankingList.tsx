'use client';

// 데스크톱 HistoryRankingTable.tsx(232줄)의 넓은 <table> 대신 카드 리스트로 과거 확정 데이터를 보여준다
// (MobileRankingList.tsx의 RankingCard와 동일한 카드 스타일 - 수칙 1-6). 종목명/코드 검색 필터도
// 데스크톱과 동일하게 포함한다. 데이터/계산은 새로 만들지 않고 부모(MobileHistoryPage)가 이미 재계산한
// displayItems를 그대로 받아 렌더링만 담당한다.

import { useState } from 'react';
import { Search } from 'lucide-react';
import { RankingItem, RankingType } from '@/lib/types';
import MobileLoadingSpinner from './MobileLoadingSpinner';

interface MobileHistoryRankingListProps {
  items: RankingItem[];
  type: RankingType;
  isLoading: boolean;
  selectedDate: string;
  overlapMode?: 'daily' | 'consecutive2d' | 'consecutive3d';
  surgingMode?: 'fluctuation' | 'volume' | 'amount' | 'overlap';
  quietFilter?: boolean;
}

function formatEok(v: number | undefined) {
  if (v === undefined) return '-';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString()}억`;
}

function HistoryCard({ item, type, isConsecutive, isSurgingOverlap, quietFilter }: { item: RankingItem; type: RankingType; isConsecutive: boolean; isSurgingOverlap: boolean; quietFilter?: boolean }) {
  const changeRate = item.changeRate || 0;
  const isUp = changeRate > 0;
  const isDown = changeRate < 0;

  // 🚨 [기능 수정] 급등주 탭은 등락률/거래량/거래대금 서브모드에서는 데스크톱
  // HistoryRankingTable.tsx(155~159번 줄)과 동일하게 거래대금(amountEok)을 보여줘야 한다 - 급등주
  // 항목은 순매수(netBuyAmtEok)가 항상 0으로 채워지므로 이전 코드처럼 무조건 surgingRanks를 찾다 못
  // 찾으면 "순매수 0억"으로 떨어지는 건 실제 버그였다(교집합 서브모드일 때만 surgingRanks가 존재).
  // 🎯 [기능 추가 - 사용자 요청: "히스토리에는 관심종목, 장마감후보군등 업데이트해야지"] postmarket은
  // 급등 상세 뱃지(surgingBadge)를, watchlist는 거래대금을 보여준다(둘 다 순매수 개념이 없음).
  const subLine = type === 'overlap'
    ? (item.ranksByType || []).map((r) => `${r.label} ${isConsecutive ? (r.consecutiveText || '당일') : `${r.netBuyAmtEok > 0 ? '+' : ''}${r.netBuyAmtEok}억`}`).join(' · ') || '-'
    : type === 'surging' && isSurgingOverlap
    ? (item.surgingRanks || []).map((r) => `${r.label} ${r.rank}위`).join(' · ') || '-'
    : type === 'postmarket'
    ? (item.surgingBadge || '-')
    : type === 'discovery'
    ? `${item.absorptionBadge || '데이터 없음'} · 점수 ${item.discoveryScore != null ? item.discoveryScore.toFixed(1) : '-'}`
    : type === 'precursor'
    ? `거래대금 ${item.volumeSurgeRatio != null ? item.volumeSurgeRatio.toFixed(2) : '-'}배${item.volumeTrendIncreasing ? ' · 증가추세' : ''} · 점수 ${item.precursorScore != null ? item.precursorScore.toFixed(1) : '-'}`
    : type === 'surging' || type === 'watchlist'
    ? `거래대금 ${item.amountEok ? `${item.amountEok}억` : '-'}`
    : type === 'comprehensive'
    ? `종합점수 ${item.scoreBreakdown?.totalScore ?? '-'}점`
    : `순매수 ${formatEok(item.netBuyAmtEok)}`;

  // 🎯 [기능 추가 - 사용자 요청: "장마감 후보군들이 다음날 실제로 상승했는지 보고싶어" /
  // "수급교집합 장마감 후보만도... 얼마나 올랐는지 두개 보여주고" / "히스토리도 장마감 후보군 업데이트"]
  const showNextDay = type === 'postmarket' || type === 'discovery' || type === 'precursor' || type === 'watchlist' || (type === 'overlap' && Boolean(quietFilter));

  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl">
      <div className="w-6 shrink-0 text-center text-xs font-bold text-slate-400 dark:text-slate-500">{item.rank}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-slate-900 dark:text-white truncate">{item.name}</span>
          <span className="text-[10px] font-mono text-slate-400 shrink-0">{item.symbol}</span>
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">{subLine}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-bold text-slate-900 dark:text-white">{(item.currentPrice || 0).toLocaleString()}</div>
        <div className={`text-[11px] font-mono font-semibold ${isUp ? 'text-red-600 dark:text-red-500' : isDown ? 'text-blue-600 dark:text-blue-500' : 'text-slate-500'}`}>
          {isUp ? '+' : ''}{changeRate.toFixed(2)}%
        </div>
        {showNextDay && (
          item.nextDayChangeRate === undefined ? (
            <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5">다음날 미수집</div>
          ) : (
            <>
              <div
                className={`text-[9px] font-semibold mt-0.5 ${
                  item.nextDayChangeRate > 0 ? 'text-red-500 dark:text-red-400' : item.nextDayChangeRate < 0 ? 'text-blue-500 dark:text-blue-400' : 'text-slate-400'
                }`}
              >
                다음날 {item.nextDayChangeRate > 0 ? '+' : ''}{item.nextDayChangeRate.toFixed(2)}%
              </div>
              {/* 🎯 [기능 추가 - 사용자 지적: "장마감되고나면 이미 뛰었다가 내려왔을수도 있는거잖아?"] */}
              {item.nextDayHighChangeRate !== undefined && (
                <div className="text-[9px] text-amber-600 dark:text-amber-400 font-medium">
                  최고 {item.nextDayHighChangeRate > 0 ? '+' : ''}{item.nextDayHighChangeRate.toFixed(2)}%
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

export default function MobileHistoryRankingList({ items, type, isLoading, selectedDate, overlapMode, surgingMode, quietFilter }: MobileHistoryRankingListProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const isConsecutive = overlapMode === 'consecutive2d' || overlapMode === 'consecutive3d';
  const isSurgingOverlap = type === 'surging' && surgingMode === 'overlap';

  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(searchTerm.toLowerCase()) || item.symbol.includes(searchTerm)
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60 shrink-0">
          📅 {selectedDate} 확정
        </span>
        <div className="relative flex-1 max-w-[160px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
          <input
            type="text"
            placeholder="종목명/코드"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full text-[11px] pl-6 pr-2 py-1.5 rounded-lg border border-slate-200 dark:border-[#2a2e39] bg-white dark:bg-[#1e222d] text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>
      </div>

      {isLoading ? (
        <MobileLoadingSpinner label="과거 확정 데이터를 불러오는 중입니다..." />
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-xs">해당 날짜({selectedDate})의 확정 데이터가 없습니다.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((item) => (
            <HistoryCard key={item.symbol} item={item} type={type} isConsecutive={isConsecutive} isSurgingOverlap={isSurgingOverlap} quietFilter={quietFilter} />
          ))}
        </div>
      )}
    </div>
  );
}
