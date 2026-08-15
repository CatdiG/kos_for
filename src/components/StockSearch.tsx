'use client';

import React, { useState } from 'react';
import { Search, Building2, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { StockInfo } from '@/lib/types';
import { PRESET_STOCKS, TOP_50_STOCKS } from '@/lib/mockData';
import { buildSearchStockList, resolveSymbolOrName } from '@/lib/stockDictionary';

interface StockSearchProps {
  currentSymbol: string;
  stockInfo?: StockInfo;
  onSelectSymbol: (symbol: string) => void;
  onRefresh?: () => void;
  isFetching?: boolean;
}

export default function StockSearch({
  currentSymbol,
  stockInfo,
  onSelectSymbol,
  onRefresh,
  isFetching = false,
}: StockSearchProps) {
  const [inputVal, setInputVal] = useState<string>('');
  const [isOpen, setIsOpen] = useState<boolean>(false);

  // Dynamic Master Stock Search Dictionary including runtime cached stocks
  const searchStockList = buildSearchStockList(PRESET_STOCKS, TOP_50_STOCKS);

  const query = inputVal.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    if (!query) return [];
    const matches = searchStockList.filter(
      (s) => s.name.toLowerCase().includes(query) || s.symbol.includes(query)
    );
    matches.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === query ? 0 : aName.startsWith(query) ? 1 : 2;
      const bExact = bName === query ? 0 : bName.startsWith(query) ? 1 : 2;
      return aExact - bExact;
    });
    return matches.slice(0, 25);
  }, [query, searchStockList]);

  const handleSelect = (symbol: string) => {
    onSelectSymbol(symbol);
    setInputVal('');
    setIsOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trim = inputVal.trim();
    if (!trim) return;

    // Resolve Korean stock name or code to 6-digit stock code
    const targetSymbol = resolveSymbolOrName(trim, searchStockList);
    handleSelect(targetSymbol);
  };

  const isUp = (stockInfo?.change || 0) >= 0;

  return (
    <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-4 sm:p-5 shadow-sm dark:shadow-xl transition-colors duration-200">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
        {/* Search Input Form & Autocomplete Dropdown */}
        <div className="relative flex-1 max-w-lg">
          <form onSubmit={handleSubmit} className="relative flex items-center">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-[#787b86]" />
            <input
              type="text"
              value={inputVal}
              onChange={(e) => {
                setInputVal(e.target.value);
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              placeholder="한글 종목명 또는 6자리 코드 검색 (예: 삼성전자, 기아, 005930)"
              className="w-full pl-10 pr-24 py-2.5 bg-slate-50 dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] focus:border-red-500/80 rounded-lg text-sm text-slate-900 dark:text-[#e0e3eb] placeholder:text-slate-400 dark:placeholder-[#787b86] outline-none transition"
            />
            <button
              type="submit"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white font-bold text-xs rounded-md transition shadow-sm cursor-pointer"
            >
              조회
            </button>
          </form>

          {/* Dropdown Results */}
          {isOpen && inputVal.trim() && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] rounded-lg shadow-xl z-50 max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-[#2a2e39]/50">
              {filtered.length > 0 ? (
                filtered.map((stock) => (
                  <button
                    key={stock.symbol}
                    type="button"
                    onClick={() => handleSelect(stock.symbol)}
                    className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-100 dark:hover:bg-[#2a2e39] text-left transition cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-slate-400 dark:text-[#787b86]" />
                      <span className="font-bold text-sm text-slate-900 dark:text-white">
                        {stock.name}
                      </span>
                      <span className="text-xs text-slate-400 dark:text-[#787b86] font-mono">
                        ({stock.symbol})
                      </span>
                    </div>
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-[#131722] text-slate-600 dark:text-gray-300 border border-slate-200 dark:border-[#2a2e39]">
                      {stock.market}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-4 py-3 text-xs text-slate-500 dark:text-[#787b86]">
                  검색어 &apos;{inputVal}&apos; 직조회 (엔터 또는 조회 클릭)
                </div>
              )}
            </div>
          )}
        </div>

        {/* Refresh & Current Stock Quick Display */}
        {stockInfo && (
          <div className="flex items-center justify-between lg:justify-end gap-4 border-t lg:border-t-0 pt-3 lg:pt-0 border-slate-100 dark:border-[#2a2e39]">
            <div className="flex items-center gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                    {stockInfo.name}
                  </h2>
                  <span className="text-xs font-mono text-slate-500 dark:text-[#787b86]">
                    {stockInfo.symbol}
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 dark:bg-[#1e222d] text-slate-700 dark:text-gray-300 border border-slate-200 dark:border-[#2a2e39]">
                    {stockInfo.market}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-[#787b86] mt-0.5">
                  거래량: {stockInfo.volume.toLocaleString()}주
                </p>
              </div>

              {/* Price Tag with 3-digit comma formatting */}
              <div className="text-right pl-3 border-l border-slate-200 dark:border-[#2a2e39]">
                <div className="text-xl font-bold font-mono text-slate-900 dark:text-white">
                  {stockInfo.currentPrice.toLocaleString()}{' '}
                  <span className="text-xs text-slate-500 dark:text-gray-400">원</span>
                </div>
                <div
                  className={`flex items-center justify-end gap-1 text-xs font-semibold font-mono ${
                    isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'
                  }`}
                >
                  {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                  <span>
                    {isUp ? '+' : ''}
                    {stockInfo.change.toLocaleString()} ({isUp ? '+' : ''}
                    {stockInfo.changeRate.toFixed(2)}%)
                  </span>
                </div>
              </div>
            </div>

            {/* Refresh Button */}
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={isFetching}
                title="수급 데이터 새로고침"
                className="p-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] text-slate-600 dark:text-[#787b86] hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-[#2a2e39] transition disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-red-600' : ''}`} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
