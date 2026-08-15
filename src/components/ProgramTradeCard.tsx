'use client';

import React from 'react';
import { ProgramTradeSummary } from '@/lib/types';
import { Cpu, ArrowUpRight, ArrowDownRight, Activity, Zap } from 'lucide-react';

interface ProgramTradeCardProps {
  programTrade?: ProgramTradeSummary;
}

export default function ProgramTradeCard({ programTrade }: ProgramTradeCardProps) {
  if (!programTrade) return null;

  const formatAmount = (amtInMillion: number) => {
    const isNeg = amtInMillion < 0;
    const abs = Math.abs(amtInMillion);
    if (abs >= 100) {
      const eok = (abs / 100).toFixed(1);
      return `${isNeg ? '-' : '+'}${eok}억원`;
    }
    return `${isNeg ? '-' : '+'}${abs.toLocaleString()}백만원`;
  };

  const getStatusBadge = (status: ProgramTradeSummary['status']) => {
    switch (status) {
      case 'STRONG_BUY':
        return { label: '프로그램 강매수', bg: 'bg-red-500/10 text-red-500 border-red-500/20' };
      case 'BUY':
        return { label: '프로그램 매수 우세', bg: 'bg-red-500/10 text-red-500 border-red-500/20' };
      case 'STRONG_SELL':
        return { label: '프로그램 강매도', bg: 'bg-blue-500/10 text-blue-500 border-blue-500/20' };
      case 'SELL':
        return { label: '프로그램 매도 우세', bg: 'bg-blue-500/10 text-blue-500 border-blue-500/20' };
      default:
        return { label: '프로그램 중립/관망', bg: 'bg-slate-500/10 text-slate-500 border-slate-500/20' };
    }
  };

  const totalAmt = programTrade.totalNetBuyAmt;
  const isPos = totalAmt >= 0;
  const badge = getStatusBadge(programTrade.status);

  // Calculate percentages for visual progress bar
  const absArb = Math.abs(programTrade.arbitrageAmt);
  const absNonArb = Math.abs(programTrade.nonArbitrageAmt);
  const totalAbs = absArb + absNonArb || 1;
  const arbPercent = Math.round((absArb / totalAbs) * 100);
  const nonArbPercent = 100 - arbPercent;

  return (
    <div className="bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-2xl p-5 shadow-sm hover:shadow-md transition-all duration-200 relative overflow-hidden">
      {/* Background Subtle Gradient Glow */}
      <div className={`absolute -right-8 -top-8 w-28 h-28 rounded-full blur-3xl opacity-15 pointer-events-none ${isPos ? 'bg-red-500' : 'bg-blue-500'}`} />

      {/* Header Row */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-slate-900 dark:text-white text-base">프로그램 매매 현황</h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/50 flex items-center gap-1">
                <Zap className="w-3 h-3 text-amber-500" />
                알고리즘 수급
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-[#787b86]">실시간 차익 / 비차익 프로그램 매매 흐름</p>
          </div>
        </div>

        {/* Status Badge */}
        <span className={`text-xs px-2.5 py-1 rounded-full font-bold border ${badge.bg}`}>
          {badge.label}
        </span>
      </div>

      {/* Main Net Buy Figures */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {/* Total Program Net Buy */}
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#1e222d] border border-slate-100 dark:border-[#2a2e39]">
          <div className="text-xs text-slate-500 dark:text-[#787b86] mb-1 flex items-center justify-between">
            <span>전체 프로그램 순매수</span>
            <span className="text-[11px] font-mono text-purple-600 dark:text-purple-400">비중 {programTrade.ratioVsVolume}%</span>
          </div>
          <div className={`text-lg font-black font-mono flex items-center gap-1 ${isPos ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>
            {isPos ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownRight className="w-5 h-5" />}
            {formatAmount(totalAmt)}
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
            {programTrade.totalNetBuyQty >= 0 ? '+' : ''}{programTrade.totalNetBuyQty.toLocaleString()} 주
          </div>
        </div>

        {/* Non-Arbitrage Net Buy (비차익) */}
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#1e222d] border border-slate-100 dark:border-[#2a2e39]">
          <div className="text-xs text-slate-500 dark:text-[#787b86] mb-1 flex items-center justify-between">
            <span>비차익 순매수 (주식 바스켓)</span>
            <span className="text-[10px] text-slate-400">비중 {nonArbPercent}%</span>
          </div>
          <div className={`text-lg font-bold font-mono ${programTrade.nonArbitrageAmt >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>
            {formatAmount(programTrade.nonArbitrageAmt)}
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
            지수 트래킹/외인·기관 알고리즘
          </div>
        </div>

        {/* Arbitrage Net Buy (차익) */}
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#1e222d] border border-slate-100 dark:border-[#2a2e39]">
          <div className="text-xs text-slate-500 dark:text-[#787b86] mb-1 flex items-center justify-between">
            <span>차익 순매수 (선물-현물 괴리율)</span>
            <span className="text-[10px] text-slate-400">비중 {arbPercent}%</span>
          </div>
          <div className={`text-lg font-bold font-mono ${programTrade.arbitrageAmt >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>
            {formatAmount(programTrade.arbitrageAmt)}
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
            베이시스 매매 (선현물 무위험)
          </div>
        </div>
      </div>

      {/* Program Trading Breakdown Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-[#787b86]">
          <span className="flex items-center gap-1">
            <Activity className="w-3.5 h-3.5 text-purple-500" />
            프로그램 비차익 vs 차익 구성 비율
          </span>
          <span className="font-mono">비차익 {nonArbPercent}% : 차익 {arbPercent}%</span>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-[#2a2e39] overflow-hidden flex">
          <div
            className="h-full bg-purple-500 transition-all duration-500"
            style={{ width: `${nonArbPercent}%` }}
            title={`비차익: ${programTrade.nonArbitrageAmt}백만원`}
          />
          <div
            className="h-full bg-amber-500 transition-all duration-500"
            style={{ width: `${arbPercent}%` }}
            title={`차익: ${programTrade.arbitrageAmt}백만원`}
          />
        </div>
      </div>
    </div>
  );
}
