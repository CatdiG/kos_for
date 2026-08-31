'use client';

import React from 'react';
import { SupplySummary, ProgramTradeSummary, RankingItem } from '@/lib/types';
import { Globe2, Landmark, Coins, Cpu, Zap, Clock } from 'lucide-react';
import { getSupplyDirection } from '@/lib/supplyUtils';
import { getSettledAsOfDateLabel } from '@/lib/mockData';

interface SupplySummaryCardsProps {
  summary?: SupplySummary;
  programTrade?: ProgramTradeSummary;
  stockInfo?: {
    symbol: string;
    name: string;
    currentPrice: number;
    change: number;
    changeRate: number;
  };
  selectedStockItem?: RankingItem;
  isLoading?: boolean;
}

export default function SupplySummaryCards({
  summary,
  programTrade,
  stockInfo,
  selectedStockItem,
  isLoading,
}: SupplySummaryCardsProps) {
  if (isLoading || !summary) {
    return (
      <div className="space-y-2 w-full">
        <div className="flex items-center gap-2 px-1 text-xs text-slate-400 animate-pulse">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
          <span className="font-semibold text-slate-600 dark:text-slate-400">수급 현황 불러오는 중...</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 bg-white dark:bg-[#131722] rounded-xl border border-slate-200 dark:border-[#2a2e39] p-4 animate-pulse flex flex-col justify-between"
            >
              <div className="flex items-center justify-between">
                <div className="h-4 w-24 bg-slate-200 dark:bg-slate-800 rounded" />
                <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg" />
              </div>
              <div className="h-7 w-32 bg-slate-200 dark:bg-slate-800 rounded" />
              <div className="h-3 w-20 bg-slate-100 dark:bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const formatAmount = (amtInMillion: number) => {
    const isNeg = amtInMillion < 0;
    const abs = Math.abs(amtInMillion);
    if (abs >= 1000000) {
      return `${isNeg ? '-' : '+'}${(abs / 1000000).toFixed(2)}조원`;
    }
    if (abs >= 100) {
      return `${isNeg ? '-' : '+'}${(abs / 100).toFixed(1)}억원`;
    }
    return `${isNeg ? '-' : '+'}${abs.toLocaleString()}백만`;
  };

  // 단일 진실 공급원(Single Source of Truth):
  // 백엔드 API(/api/stock/investor-trend)의 실시간 summary 데이터를 어느 탭에서나 100% 일관되게 단일 소비
  const foreignMetric = {
    ...summary.foreign,
    todayEstimateAmt: summary.foreign.todayEstimateAmt ?? 0,
    todayEstimateQty: summary.foreign.todayEstimateQty ?? 0,
    asOfDateLabel: summary.foreign.asOfDateLabel || getSettledAsOfDateLabel(),
    isFallback: summary.foreign.isFallback ?? false,
  };

  const organMetric = {
    ...summary.organ,
    todayEstimateAmt: summary.organ.todayEstimateAmt ?? 0,
    todayEstimateQty: summary.organ.todayEstimateQty ?? 0,
    asOfDateLabel: summary.organ.asOfDateLabel || getSettledAsOfDateLabel(),
    isFallback: summary.organ.isFallback ?? false,
  };

  const programAmt = programTrade?.totalNetBuyAmt ?? (summary.program?.todayEstimateAmt ?? 0);
  const programQty = programTrade?.totalNetBuyQty ?? (summary.program?.todayEstimateQty ?? 0);
  const programAsOfDateLabel = programTrade?.asOfDateLabel || summary.program?.asOfDateLabel || getSettledAsOfDateLabel();

  const cards = [
    {
      title: '외국인 수급 현황',
      subtitle: 'Foreign Investor',
      icon: Globe2,
      metric: foreignMetric,
    },
    {
      title: '기관 수급 현황',
      subtitle: 'Institutional Investor',
      icon: Landmark,
      metric: organMetric,
    },
  ];

  const programDirectionInfo = getSupplyDirection(programAmt);
  const ProgramIcon = programDirectionInfo.Icon;

  const nonArbAmt = programTrade?.nonArbitrageAmt ?? Math.round(programAmt * 0.9);
  const arbAmt = programTrade?.arbitrageAmt ?? Math.round(programAmt * 0.1);
  const nonArbDir = getSupplyDirection(nonArbAmt);
  const arbDir = getSupplyDirection(arbAmt);

  return (
    <div className="w-full space-y-2">
      {/* Target Stock Label Header */}
      {stockInfo && (
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
              📌 {stockInfo.name} <span className="font-mono text-slate-400 dark:text-slate-500 font-normal">({stockInfo.symbol})</span> 개별 수급 현황
            </span>
          </div>
          <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
            현재가: {stockInfo.currentPrice.toLocaleString()}원 ({stockInfo.changeRate > 0 ? '+' : ''}{stockInfo.changeRate}%)
          </span>
        </div>
      )}

      {/* 3 Summary Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full">
        {/* 1~2: Foreign, Institution */}
        {cards.map((card) => {
          const Icon = card.icon;
          const directionInfo = getSupplyDirection(card.metric.todayEstimateAmt);
          const DirectionIcon = directionInfo.Icon;

          return (
            <div
              key={card.title}
              className="bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-2xl p-4 sm:p-5 shadow-sm dark:shadow-lg relative overflow-hidden transition hover:border-slate-300 dark:hover:border-[#363c4e] flex flex-col justify-between"
            >
              {/* Background Glow Overlay */}
              <div
                className={`absolute -right-6 -bottom-6 w-28 h-28 rounded-full blur-2xl pointer-events-none opacity-10 dark:opacity-15 ${
                  directionInfo.direction === 'BUY'
                    ? 'bg-red-500'
                    : directionInfo.direction === 'SELL'
                    ? 'bg-blue-500'
                    : 'bg-slate-400'
                }`}
              />

              <div>
                {/* Header Row - Single line, shrink-0 badges */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`p-2.5 rounded-xl border shrink-0 ${
                        directionInfo.direction === 'BUY'
                          ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/40 text-red-600 dark:text-red-400'
                          : directionInfo.direction === 'SELL'
                          ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800/40 text-blue-600 dark:text-blue-400'
                          : 'bg-slate-100 dark:bg-gray-800 border-slate-200 dark:border-gray-700 text-slate-500 dark:text-gray-400'
                      }`}
                    >
                      <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white tracking-tight whitespace-nowrap truncate">
                        {card.title}
                      </h3>
                      <p className="text-[11px] text-slate-400 dark:text-[#787b86] font-mono whitespace-nowrap truncate">
                        {card.subtitle}
                      </p>
                    </div>
                  </div>

                  <span className={`text-[10px] sm:text-[11px] font-bold px-2 sm:px-2.5 py-0.5 rounded-full border shrink-0 whitespace-nowrap ${directionInfo.bgClass}`}>
                    {directionInfo.label}
                  </span>
                </div>
                {/* Today Estimate Main Metric */}
                <div className="my-3 pb-3 border-b border-slate-100 dark:border-[#2a2e39]/60">
                  <div className="text-xs text-slate-500 dark:text-[#787b86] mb-1 whitespace-nowrap flex items-center justify-between">
                    {(() => {
                      const isEstimate = card.metric.asOfDateLabel?.includes('잠정') || card.metric.asOfDateLabel?.includes('추정') || card.metric.asOfDateLabel?.includes('가집계');
                      return (
                        <>
                          <span className="flex items-center gap-1">
                            {isEstimate ? '당일 잠정 순매수' : '마감 확정 순매수'}
                            {isEstimate ? (
                              <span className="text-[9px] px-1 py-0.2 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 font-bold border border-amber-200 dark:border-amber-800/40">
                                추정
                              </span>
                            ) : (
                              <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-200 dark:border-emerald-800/40">
                                확정
                              </span>
                            )}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 font-semibold">
                            {card.metric.asOfDateLabel || getSettledAsOfDateLabel()}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                  <div className="flex items-baseline justify-between gap-1">
                    <div
                      className={`text-xl sm:text-2xl font-bold font-mono tracking-tight flex items-center gap-0.5 whitespace-nowrap ${directionInfo.colorClass}`}
                    >
                      <DirectionIcon className="w-5 h-5 shrink-0" />
                      <span>{formatAmount(card.metric.todayEstimateAmt)}</span>
                    </div>
                    <span className="text-[11px] sm:text-xs text-slate-500 dark:text-[#787b86] font-mono whitespace-nowrap shrink-0">
                      {card.metric.todayEstimateQty > 0 ? '+' : ''}
                      {card.metric.todayEstimateQty.toLocaleString()}주
                    </span>
                  </div>
                </div>
              </div>

              {/* Cumulative Metric Grid (5D, 20D, 60D) */}
              <div className="grid grid-cols-3 gap-1 text-center pt-1 w-full min-w-0">
                {/* 5D */}
                {(() => {
                  const d5 = getSupplyDirection(card.metric.net5d);
                  return (
                    <div className="bg-slate-50 dark:bg-[#1e222d] p-1.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]/50 min-w-0 overflow-hidden">
                      <div className="text-[9px] sm:text-[10px] text-slate-500 dark:text-[#787b86] mb-0.5 whitespace-nowrap truncate">5일 누적</div>
                      <div className={`text-[10px] sm:text-[11px] font-bold font-mono whitespace-nowrap truncate ${d5.colorClass}`}>
                        {formatAmount(card.metric.net5d)}
                      </div>
                    </div>
                  );
                })()}

                {/* 20D */}
                {(() => {
                  const d20 = getSupplyDirection(card.metric.net20d);
                  return (
                    <div className="bg-slate-50 dark:bg-[#1e222d] p-1.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]/50 min-w-0 overflow-hidden">
                      <div className="text-[9px] sm:text-[10px] text-slate-500 dark:text-[#787b86] mb-0.5 whitespace-nowrap truncate">20일 누적</div>
                      <div className={`text-[10px] sm:text-[11px] font-bold font-mono whitespace-nowrap truncate ${d20.colorClass}`}>
                        {formatAmount(card.metric.net20d)}
                      </div>
                    </div>
                  );
                })()}

                {/* 60D */}
                {(() => {
                  const d60 = getSupplyDirection(card.metric.net60d);
                  return (
                    <div className="bg-slate-50 dark:bg-[#1e222d] p-1.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]/50 min-w-0 overflow-hidden">
                      <div className="text-[9px] sm:text-[10px] text-slate-500 dark:text-[#787b86] mb-0.5 whitespace-nowrap truncate">60일 누적</div>
                      <div className={`text-[10px] sm:text-[11px] font-bold font-mono whitespace-nowrap truncate ${d60.colorClass}`}>
                        {formatAmount(card.metric.net60d)}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}

        {/* 4: Program Trade Status Card (Unified Outer Design + Date Label) */}
        <div className="bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-2xl p-4 sm:p-5 shadow-sm dark:shadow-lg relative overflow-hidden transition hover:border-slate-300 dark:hover:border-[#363c4e] flex flex-col justify-between">
          <div
            className={`absolute -right-6 -bottom-6 w-28 h-28 rounded-full blur-2xl pointer-events-none opacity-10 dark:opacity-15 ${
              programDirectionInfo.direction === 'BUY'
                ? 'bg-red-500'
                : programDirectionInfo.direction === 'SELL'
                ? 'bg-blue-500'
                : 'bg-slate-400'
            }`}
          />

          <div>
            {/* Header Row */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={`p-2.5 rounded-xl border shrink-0 ${
                    programDirectionInfo.direction === 'BUY'
                      ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/40 text-red-600 dark:text-red-400'
                      : programDirectionInfo.direction === 'SELL'
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800/40 text-blue-600 dark:text-blue-400'
                      : 'bg-slate-100 dark:bg-gray-800 border-slate-200 dark:border-gray-700 text-slate-500 dark:text-gray-400'
                  }`}
                >
                  <Cpu className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white tracking-tight whitespace-nowrap truncate">
                    프로그램 수급 현황
                  </h3>
                  <p className="text-[11px] text-slate-400 dark:text-[#787b86] font-mono whitespace-nowrap truncate">
                    Program Trading
                  </p>
                </div>
              </div>

              <span className={`text-[10px] sm:text-[11px] font-bold px-2 sm:px-2.5 py-0.5 rounded-full border shrink-0 whitespace-nowrap ${programDirectionInfo.bgClass}`}>
                {programDirectionInfo.label}
              </span>
            </div>

            {/* Total Program Net Buy Main Metric */}
            <div className="my-3 pb-3 border-b border-slate-100 dark:border-[#2a2e39]/60">
              <div className="text-xs text-slate-500 dark:text-[#787b86] mb-1 flex items-center justify-between whitespace-nowrap">
                {(() => {
                  const isRealtime = programAsOfDateLabel.includes('실시간');
                  const isEstimate = programAsOfDateLabel.includes('가집계') || programAsOfDateLabel.includes('잠정') || programAsOfDateLabel.includes('추정');
                  return (
                    <>
                      <span className="flex items-center gap-1">
                        {isRealtime ? '당일 실시간 순매수' : (isEstimate ? '당일 잠정 순매수' : '마감 확정 순매수')}
                        {isRealtime ? (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-bold border border-blue-200 dark:border-blue-800/40">
                            실시간
                          </span>
                        ) : isEstimate ? (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 font-bold border border-amber-200 dark:border-amber-800/40">
                            추정
                          </span>
                        ) : (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-200 dark:border-emerald-800/40">
                            확정
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 font-semibold">
                        {programAsOfDateLabel}
                      </span>
                    </>
                  );
                })()}
              </div>
              <div className="flex items-baseline justify-between gap-1">
                <div className={`text-xl sm:text-2xl font-bold font-mono tracking-tight flex items-center gap-0.5 whitespace-nowrap ${programDirectionInfo.colorClass}`}>
                  <ProgramIcon className="w-5 h-5 shrink-0" />
                  <span>{formatAmount(programAmt)}</span>
                </div>
                <span className="text-[11px] sm:text-xs text-slate-500 dark:text-[#787b86] font-mono whitespace-nowrap shrink-0">
                  {programQty >= 0 ? '+' : ''}
                  {programQty.toLocaleString()}주
                </span>
              </div>
            </div>
          </div>

          {/* Breakdown Grid (Non-Arbitrage vs Arbitrage) */}
          <div className="grid grid-cols-2 gap-2 text-center pt-1">
            <div className="bg-slate-50 dark:bg-[#1e222d] p-1.5 sm:p-2 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]/50 min-w-0 overflow-hidden">
              <div className="text-[9px] sm:text-[10px] text-slate-500 dark:text-[#787b86] mb-0.5 whitespace-nowrap truncate">비차익 순매수</div>
              <div className={`text-[10px] sm:text-[11px] font-bold font-mono whitespace-nowrap truncate ${nonArbDir.colorClass}`}>
                {formatAmount(nonArbAmt)}
              </div>
            </div>

            <div className="bg-slate-50 dark:bg-[#1e222d] p-1.5 sm:p-2 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]/50 min-w-0 overflow-hidden">
              <div className="text-[9px] sm:text-[10px] text-slate-500 dark:text-[#787b86] mb-0.5 whitespace-nowrap truncate">차익 순매수</div>
              <div className={`text-[10px] sm:text-[11px] font-bold font-mono whitespace-nowrap truncate ${arbDir.colorClass}`}>
                {formatAmount(arbAmt)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
