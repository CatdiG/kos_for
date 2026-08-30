'use client';

import React, { useState } from 'react';
import { RankingItem, RankingType, RankingPeriod, MarketType } from '@/lib/types';
import Link from 'next/link';

interface HistoryRankingTableProps {
  items: RankingItem[];
  type: RankingType;
  period: RankingPeriod;
  market: MarketType;
  isLoading: boolean;
  selectedDate: string;
  onStockClick?: (symbol: string) => void;
}

export const HistoryRankingTable: React.FC<HistoryRankingTableProps> = ({
  items,
  type,
  period,
  market,
  isLoading,
  selectedDate,
  onStockClick,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredItems = items.filter((item) =>
    item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.symbol.includes(searchTerm)
  );

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
      {/* 테이블 상단 컨트롤 바 */}
      <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
            📅 {selectedDate} 확정 데이터
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            총 {filteredItems.length}개 종목
          </span>
        </div>

        <div className="relative">
          <input
            type="text"
            placeholder="종목명/코드 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="text-xs px-3 py-1.5 pl-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48"
          />
          <svg
            className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* 테이블 영역 */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-800/40 text-slate-600 dark:text-slate-400 text-xs font-semibold">
              <th className="py-3 px-4 w-16 text-center">순위</th>
              <th className="py-3 px-4 min-w-[160px]">종목명</th>
              <th className="py-3 px-4 text-right">종가</th>
              <th className="py-3 px-4 text-right">등락률</th>
              <th className="py-3 px-4 text-right">거래량</th>
              {type === 'surging' || type === 'comprehensive' ? (
                <th className="py-3 px-4 text-right">거래대금</th>
              ) : null}
              {type === 'comprehensive' ? (
                <th className="py-3 px-4 text-center">종합점수</th>
              ) : null}
              {type !== 'surging' && type !== 'comprehensive' ? (
                <th className="py-3 px-4 text-right">순매수금액</th>
              ) : null}
              {type === 'overlap' ? (
                <th className="py-3 px-4 min-w-[200px]">수급 주체</th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400 text-sm">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span>과거 확정 데이터를 불러오는 중입니다...</span>
                  </div>
                </td>
              </tr>
            ) : filteredItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400 text-sm">
                  해당 날짜({selectedDate})의 확정 데이터가 없습니다.
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => {
                const isPositive = (item.changeRate || 0) > 0;
                const isNegative = (item.changeRate || 0) < 0;
                const priceColor = isPositive ? 'text-red-500 dark:text-red-400' : isNegative ? 'text-blue-500 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300';

                return (
                  <tr
                    key={item.symbol}
                    onClick={() => onStockClick && onStockClick(item.symbol)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                  >
                    <td className="py-3 px-4 text-center font-bold text-slate-500 dark:text-slate-400">
                      {item.rank}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900 dark:text-slate-100 hover:text-indigo-600 transition-colors">
                          {item.name}
                        </span>
                        <span className="text-xs text-slate-400">
                          {item.symbol}
                        </span>
                        {item.market ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            item.market === 'KOSPI' ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' : 'bg-green-50 text-green-600 dark:bg-green-950/40 dark:text-green-400'
                          }`}>
                            {item.market}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-slate-800 dark:text-slate-200">
                      {(item.currentPrice || 0).toLocaleString()}원
                    </td>
                    <td className={`py-3 px-4 text-right font-semibold ${priceColor}`}>
                      {isPositive ? '+' : ''}{(item.changeRate || 0).toFixed(2)}%
                    </td>
                    <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-400 text-xs">
                      {(item.volume || 0).toLocaleString()}
                    </td>
                    {type === 'surging' || type === 'comprehensive' ? (
                      <td className="py-3 px-4 text-right font-medium text-slate-800 dark:text-slate-200">
                        {item.amountEok ? `${item.amountEok}억` : '-'}
                      </td>
                    ) : null}
                    {type === 'comprehensive' ? (
                      <td className="py-3 px-4 text-center font-bold text-indigo-600 dark:text-indigo-400">
                        {item.scoreBreakdown?.totalScore || '-'}점
                      </td>
                    ) : null}
                    {type !== 'surging' && type !== 'comprehensive' ? (
                      <td className="py-3 px-4 text-right font-bold text-indigo-600 dark:text-indigo-400">
                        {item.netBuyAmtEok !== undefined ? (
                          <span>
                            {item.netBuyAmtEok > 0 ? `+${item.netBuyAmtEok}` : item.netBuyAmtEok}억
                          </span>
                        ) : '-'}
                      </td>
                    ) : null}
                    {type === 'overlap' ? (
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1">
                          {(item.ranksByType || []).map((r, idx) => (
                            <span
                              key={idx}
                              className="text-[11px] px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-medium border border-indigo-100 dark:border-indigo-900/50"
                            >
                              {r.label} ({r.netBuyAmtEok > 0 ? `+${r.netBuyAmtEok}` : r.netBuyAmtEok}억)
                            </span>
                          ))}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
