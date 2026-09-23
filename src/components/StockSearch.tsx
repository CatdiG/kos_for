'use client';

import React, { useState, useRef } from 'react';
import { Search, Building2, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { StockInfo } from '@/lib/types';
import { PRESET_STOCKS, TOP_50_STOCKS } from '@/lib/mockData';
import { KRX_SYMBOL_PATTERN, buildSearchStockList, filterSearchStockList, getStockName, resolveSymbolOrName } from '@/lib/stockDictionary';
import StockBadgeStrip from './StockBadgeStrip';

interface StockSearchProps {
  stockInfo?: StockInfo;
  onSelectSymbol: (symbol: string) => void;
  onRefresh?: () => void;
  isFetching?: boolean;
  // 🚨 [UI 수정] 검색창에서 종목을 검색해놓은 뒤, 매매순위 테이블에서 다른 종목을 클릭하거나 코스피/코스닥
  // 지수 카드를 클릭해 다른 화면으로 이동했을 때 - 검색창엔 여전히 이전에 검색했던 종목명이 남아있어
  // 사용자가 헷갈리는 문제가 있었다. 이 두 경로(부모 page.tsx)에서만 증가시키는 신호값을 받아서, 검색창
  // 자체 선택(handleSelect)이 아닌 "외부에서 다른 화면으로 이동"한 경우에만 검색창 텍스트를 비운다.
  clearSearchSignal?: number;
}

export default function StockSearch({
  stockInfo,
  onSelectSymbol,
  onRefresh,
  isFetching = false,
  clearSearchSignal,
}: StockSearchProps) {
  const [inputVal, setInputVal] = useState<string>('');
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [isThrottled, setIsThrottled] = useState<boolean>(false);

  // clearSearchSignal이 바뀔 때만(검색창 자체 선택 시엔 바뀌지 않음) 검색창 입력값을 비운다.
  React.useEffect(() => {
    if (clearSearchSignal === undefined) return;
    setInputVal('');
    setIsOpen(false);
    setSelectedIndex(-1);
  }, [clearSearchSignal]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Dynamic Master Stock Search Dictionary including runtime cached stocks
  const searchStockList = buildSearchStockList(PRESET_STOCKS, TOP_50_STOCKS);

  const query = inputVal.trim().toLowerCase();

  const filtered = React.useMemo(
    () => filterSearchStockList(searchStockList, query, 25),
    [query, searchStockList]
  );

  // 🚨 [버그 수정 - 사용자 요청: 한글 조합 중 Enter로도 선택] 기존엔 handleKeyDown 첫 줄에서 조합 중(isComposing)
  // keydown을 통째로 무시했다. macOS Chrome은 조합 중 Enter 뒤에 조합이 끝난 Enter keydown이 한 번 더 와서
  // 그걸로 선택됐지만, Windows Chrome은 조합 중 Enter keydown 한 번만 오기 때문에 "코윈" 입력 후 Enter를 쳐도
  // 아무 일도 안 일어났다. 두 환경을 다 맞추기 위해:
  //  1) 조합 중 Enter는 "대기"만 표시해두고, 조합이 확정되는 compositionend에서 선택한다(확정된 최종 글자 기준).
  //  2) 그 선택 직후 macOS식으로 뒤따라오는 일반 Enter keydown 1회는 중복이므로 무시한다(다른 입력이 들어오면 해제).
  const imeEnterPendingRef = useRef<boolean>(false);
  const skipNextEnterRef = useRef<boolean>(false);

  // Reset selectedIndex ONLY when search query text actually changes (not on array re-creation)
  React.useEffect(() => {
    setSelectedIndex(-1);
  }, [query]);

  // Auto-scroll highlighted dropdown item into view when navigating via arrow keys
  React.useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const children = listRef.current.children;
      if (children[selectedIndex]) {
        (children[selectedIndex] as HTMLElement).scrollIntoView({
          block: 'nearest',
          behavior: 'auto',
        });
      }
    }
  }, [selectedIndex]);

  // Click outside to close dropdown
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSelectedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (symbol: string, stockName?: string) => {
    onSelectSymbol(symbol);
    const displayName = stockName || getStockName(symbol);
    setInputVal(displayName !== symbol ? displayName : symbol);
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  // 드롭다운 목록 없이 입력 문자열만으로 조회(정확 일치 → resolveSymbolOrName 순) - 조회 버튼/Enter 공통
  const submitText = (text: string) => {
    const trim = text.trim();
    if (!trim) return;

    // Resolve Korean stock name or code to 6-digit stock code
    const matched = searchStockList.find(
      (s) => s.name.toLowerCase() === trim.toLowerCase() || s.symbol.toLowerCase() === trim.toLowerCase()
    );
    const targetSymbol = matched ? matched.symbol : resolveSymbolOrName(trim, searchStockList);
    // 해석 불가(목록에 없는 이름) - 조회하지 않고 드롭다운의 "검색 결과 없음" 안내를 띄운 채로 둔다
    if (!targetSymbol) {
      setIsOpen(true);
      return;
    }
    // 🚨 [버그 수정] getStockName의 두 번째 인자는 "KIS API가 준 이름" 자리라, 여기에 사용자가 친 글자(trim)를
    // 넘기면 "삼성" → 삼성전자 부분일치 선택 시 "삼성"이 005930의 이름으로 런타임 캐시에 등록됐다.
    const displayName = matched ? matched.name : getStockName(targetSymbol);
    handleSelect(targetSymbol, displayName);
  };

  // Enter 선택 공통: 방향키로 고른 항목 → 없으면 드롭다운 첫 항목 → 드롭다운이 비었으면 입력 문자열로 조회
  const commitEnter = (text: string) => {
    const list = filterSearchStockList(searchStockList, text, 25);
    if (selectedIndex >= 0 && selectedIndex < list.length) {
      handleSelect(list[selectedIndex].symbol, list[selectedIndex].name);
    } else if (list.length > 0) {
      handleSelect(list[0].symbol, list[0].name);
    } else {
      submitText(text);
    }
  };

  // Windows 한글 IME는 조합 중 Enter의 e.key를 'Process'로 줄 수 있어 물리 키(e.code)도 함께 본다
  const isEnterKey = (e: React.KeyboardEvent<HTMLInputElement>) =>
    e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    if (!imeEnterPendingRef.current) return;
    imeEnterPendingRef.current = false;
    skipNextEnterRef.current = true;
    commitEnter(e.currentTarget.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 조합 중 keydown은 기존처럼 처리하지 않되, Enter였다면 compositionend에서 선택하도록 표시만 해둔다.
    // (여기서 preventDefault하면 일부 환경에서 IME 확정 자체가 막힐 수 있어 호출하지 않는다)
    if (e.nativeEvent.isComposing) {
      if (isEnterKey(e)) imeEnterPendingRef.current = true;
      return;
    }

    // compositionend에서 이미 선택을 끝낸 뒤 macOS식으로 뒤따라온 Enter - 중복 선택/폼 제출 방지
    if (skipNextEnterRef.current) {
      skipNextEnterRef.current = false;
      if (isEnterKey(e)) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(false);
      setSelectedIndex(-1);
      return;
    }

    if (filtered.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) setIsOpen(true);
      setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) setIsOpen(true);
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === 'Enter') {
      if (selectedIndex >= 0 && selectedIndex < filtered.length) {
        e.preventDefault();
        const selected = filtered[selectedIndex];
        handleSelect(selected.symbol, selected.name);
      } else if (filtered.length > 0) {
        // If no item was explicitly highlighted with Arrow keys, select 1st match on Enter
        e.preventDefault();
        const firstMatch = filtered[0];
        handleSelect(firstMatch.symbol, firstMatch.name);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedIndex >= 0 && selectedIndex < filtered.length) {
      const selected = filtered[selectedIndex];
      handleSelect(selected.symbol, selected.name);
      return;
    }

    submitText(inputVal);
  };

  const isUp = (stockInfo?.change || 0) >= 0;

  return (
    <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-4 sm:p-5 shadow-sm dark:shadow-xl transition-colors duration-200">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
        {/* Search Input Form & Autocomplete Dropdown */}
        <div ref={wrapperRef} className="relative flex-1 max-w-lg">
          <form onSubmit={handleSubmit} className="relative flex items-center">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-[#787b86]" />
            <input
              type="text"
              value={inputVal}
              onChange={(e) => {
                skipNextEnterRef.current = false;
                setInputVal(e.target.value);
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              onKeyDown={handleKeyDown}
              onCompositionEnd={handleCompositionEnd}
              placeholder="한글 종목명 또는 6자리 코드 검색 (예: 지투파워, 삼성전자, 388050)"
              className="w-full pl-10 pr-24 py-2.5 bg-slate-50 dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] focus:border-red-500/80 rounded-lg text-sm text-slate-900 dark:text-[#e0e3eb] placeholder:text-slate-400 dark:placeholder-[#787b86] outline-none transition font-semibold"
            />
            <button
              type="submit"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white font-bold text-xs rounded-md transition shadow-sm cursor-pointer"
            >
              조회
            </button>
          </form>

          {/* Dropdown Results with High-Contrast Selection & Auto Scroll */}
          {isOpen && inputVal.trim() && (
            <div
              ref={listRef}
              className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] rounded-lg shadow-2xl z-50 max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-[#2a2e39]/50"
            >
              {filtered.length > 0 ? (
                filtered.map((stock, idx) => {
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={stock.symbol}
                      type="button"
                      onClick={() => handleSelect(stock.symbol, stock.name)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full px-4 py-2.5 flex items-center justify-between text-left transition cursor-pointer ${
                        isSelected
                          ? 'bg-slate-200/90 dark:bg-[#2e3445] text-slate-900 dark:text-white font-black border-l-4 border-slate-600 dark:border-slate-400 shadow-2xs'
                          : 'hover:bg-slate-100 dark:hover:bg-[#1e222d] text-slate-900 dark:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Building2 className={`w-4 h-4 ${isSelected ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-[#787b86]'}`} />
                        <span className={`text-sm ${isSelected ? 'font-black text-slate-900 dark:text-white' : 'font-bold text-slate-900 dark:text-white'}`}>
                          {stock.name}
                        </span>
                        <span className={`text-xs font-mono ${isSelected ? 'text-slate-600 dark:text-slate-300 font-bold' : 'text-slate-400 dark:text-[#787b86]'}`}>
                          ({stock.symbol})
                        </span>
                      </div>
                      <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
                        isSelected
                          ? 'bg-slate-300/80 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-400/60 dark:border-slate-500 font-bold'
                          : 'bg-slate-100 dark:bg-[#131722] text-slate-600 dark:text-gray-300 border-slate-200 dark:border-[#2a2e39]'
                      }`}>
                        {stock.market}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="px-4 py-3 text-xs text-slate-500 dark:text-[#787b86]">
                  {KRX_SYMBOL_PATTERN.test(inputVal.trim().toUpperCase())
                    ? <>종목코드 &apos;{inputVal.trim().toUpperCase()}&apos; 직조회 (엔터 또는 조회 클릭)</>
                    : <>&apos;{inputVal.trim()}&apos; 검색 결과 없음 (종목명 또는 6자리 코드로 검색)</>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 종목 검색과 종목명/가격 사이 빈 공간 - 현재 존재하는 모든 랭킹 탭 뱃지 모음 */}
        {stockInfo && <StockBadgeStrip symbol={stockInfo.symbol} />}

        {/* Refresh & Current Stock Quick Display */}
        {stockInfo && (
          <div className="flex items-center justify-between lg:justify-end gap-4 border-t lg:border-t-0 pt-3 lg:pt-0 border-slate-100 dark:border-[#2a2e39] shrink-0">
            <div className="flex items-center gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                    {getStockName(stockInfo.symbol, stockInfo.name)}
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

            {/* Refresh Button with 3s Throttle Protection */}
            {onRefresh && (
              <button
                onClick={() => {
                  if (isThrottled || isFetching) return;
                  setIsThrottled(true);
                  onRefresh();
                  setTimeout(() => setIsThrottled(false), 3000);
                }}
                disabled={isFetching || isThrottled}
                title={isThrottled ? '새로고침 쿨다운 중 (3초)' : '수급 데이터 새로고침'}
                className="p-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] text-slate-600 dark:text-[#787b86] hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-[#2a2e39] transition disabled:opacity-50 cursor-pointer flex items-center gap-1"
              >
                <RefreshCw className={`w-4 h-4 ${isFetching || isThrottled ? 'animate-spin text-red-600' : ''}`} />
                {isThrottled && <span className="text-[10px] font-mono font-bold text-amber-600">3s</span>}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
