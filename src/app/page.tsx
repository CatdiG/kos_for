// Next.js Main Page
'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Header from '@/components/Header';
import StockSearch from '@/components/StockSearch';
import SupplySummaryCards from '@/components/SupplySummaryCards';
import InvestorTrendTable from '@/components/InvestorTrendTable';
import InvestorRankingTable from '@/components/InvestorRankingTable';
import { InvestorTrendResponse, RankingItem, TrendPeriod } from '@/lib/types';
import { AlertCircle, RefreshCw } from 'lucide-react';

async function fetchInvestorTrend(symbol: string, period: TrendPeriod): Promise<InvestorTrendResponse> {
  const res = await fetch(`/api/stock/investor-trend?symbol=${symbol}&period=${period}`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '수급 데이터를 가져오는 중 오류가 발생했습니다.');
  }
  return res.json();
}

export default function DashboardPage() {
  const [symbol, setSymbol] = useState<string>('005930');
  const [period, setPeriod] = useState<TrendPeriod>('60d');
  const [selectedStockItem, setSelectedStockItem] = useState<RankingItem | undefined>();

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<InvestorTrendResponse>({
    queryKey: ['investorTrend', symbol, period],
    queryFn: () => fetchInvestorTrend(symbol, period),
    placeholderData: (previousData) => previousData,
  });

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0b0e14] flex flex-col font-sans text-slate-900 dark:text-[#e0e3eb] transition-colors duration-200">
      {/* Bloomberg/TradingView Header */}
      <Header />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Stock Search & Preset Selector */}
        <StockSearch
          currentSymbol={symbol}
          stockInfo={data?.stockInfo}
          onSelectSymbol={(newSym) => {
            setSymbol(newSym);
            setSelectedStockItem(undefined);
          }}
          onRefresh={() => refetch()}
          isFetching={isFetching}
        />

        {/* Error Alert Box */}
        {isError && (
          <div className="p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl flex items-center justify-between text-red-700 dark:text-red-300 text-xs font-medium shadow-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span>{(error as Error)?.message || '데이터를 로드하지 못했습니다.'}</span>
            </div>
            <button
              onClick={() => refetch()}
              className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded transition flex items-center gap-1 shadow-sm"
            >
              <RefreshCw className="w-3 h-3" />
              <span>재시도</span>
            </button>
          </div>
        )}

        {/* Loading State Skeletons (Initial Load Only) */}
        {isLoading && !data ? (
          <div className="space-y-6 animate-pulse">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="h-44 bg-white dark:bg-[#131722] rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-sm" />
              <div className="h-44 bg-white dark:bg-[#131722] rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-sm" />
              <div className="h-44 bg-white dark:bg-[#131722] rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-sm" />
            </div>
            <div className="h-96 bg-white dark:bg-[#131722] rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-sm" />
            <div className="h-80 bg-white dark:bg-[#131722] rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-sm" />
          </div>
        ) : (
          <>
            {/* 4 Summary Cards (Foreigner, Institution, Pension Fund, Program Trading) */}
            <SupplySummaryCards
              summary={data?.summary}
              programTrade={data?.programTrade}
              stockInfo={data?.stockInfo}
              selectedStockItem={selectedStockItem}
              isLoading={isLoading}
            />

            {/* Investor Type Ranking Table & Side-by-side Unified Main Stock Detail Chart */}
            <InvestorRankingTable
              selectedSymbol={symbol}
              chartData={data}
              onSelectSymbol={(sym, item) => {
                setSymbol(sym);
                setSelectedStockItem(item);
              }}
            />

            {/* Detailed Sortable Daily Data Table */}
            <InvestorTrendTable trend={data?.trend || []} />
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-[#2a2e39] bg-white dark:bg-[#131722] py-4 px-6 mt-12 text-center text-xs text-slate-500 dark:text-[#787b86] transition-colors duration-200">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>한국투자증권(KIS) Open API 기반 외국인 · 기관 · 연기금 주식 수급 분석 시스템</span>
          <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">Next.js App Router • Recharts • TanStack Query</span>
        </div>
      </footer>
    </div>
  );
}
