'use client';

// 데스크톱 StockSearch.tsx의 모바일판 - 키보드 방향키 탐색 등 데스크톱 전용 상호작용은 빼고, 탭으로
// 결과를 고르는 터치 친화적 드롭다운만 남긴다. 검색 사전(buildSearchStockList/resolveSymbolOrName)은
// StockSearch.tsx가 쓰는 것과 동일한 걸 그대로 import해서 재사용한다(수칙 1-6, 새 검색 로직 금지).
// 종목 선택 시 investor-trend를 조회해 기존 SupplySummaryCards.tsx에 그대로 넘긴다 - 이 컴포넌트는
// 오늘 375px 실측에서 이미 정상 렌더링을 확인해 새로 만들지 않는다.
//
// 🚨 [버그 수정] symbol이 완전 내부(local) state라 매매순위 리스트(MobileRankingList)에서 종목을
// 눌러도 이 컴포넌트로 전달할 방법이 없어 "아무 반응 없음" 버그가 났다(실측 확인: RankingCard에
// onClick 자체가 없었음). 데스크톱 page.tsx가 StockSearch에 currentSymbol을 controlled로 내려주는
// 패턴(수칙 1-6)과 동일하게 externalSymbol prop을 추가해 외부에서 강제로 열 수 있게 한다.
import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { PRESET_STOCKS, TOP_50_STOCKS } from '@/lib/mockData';
import { buildSearchStockList, getStockName, resolveSymbolOrName } from '@/lib/stockDictionary';
import { InvestorTrendResponse } from '@/lib/types';
import SupplySummaryCards from '@/components/SupplySummaryCards';
import StockBadgeStrip from '@/components/StockBadgeStrip';
import MobileStockDetailChart from './MobileStockDetailChart';

async function fetchInvestorTrend(symbol: string): Promise<InvestorTrendResponse> {
  const res = await fetch(`/api/stock/investor-trend?symbol=${symbol}&period=60d`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '수급 데이터를 가져오는 중 오류가 발생했습니다.');
  }
  return res.json();
}

interface MobileStockSearchProps {
  // 랭킹 리스트 등 외부에서 강제로 열고 싶은 종목코드. 값이 바뀔 때마다 검색 입력/조회 상태를 동기화한다.
  externalSymbol?: string;
  // 종목이 최종 선택(검색 또는 외부 지정)될 때마다 상위에 알려 상태를 동기화한다.
  onSymbolChange?: (symbol: string) => void;
}

export default function MobileStockSearch({ externalSymbol, onSymbolChange }: MobileStockSearchProps) {
  const [inputVal, setInputVal] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [symbol, setSymbol] = useState<string>('');
  const wrapperRef = useRef<HTMLDivElement>(null);

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
    return matches.slice(0, 15);
  }, [query, searchStockList]);

  const handleSelect = (sym: string, name?: string) => {
    setSymbol(sym);
    setInputVal(name || getStockName(sym));
    setIsOpen(false);
    onSymbolChange?.(sym);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trim = inputVal.trim();
    if (!trim) return;
    const matched = searchStockList.find((s) => s.name.toLowerCase() === trim.toLowerCase() || s.symbol === trim);
    const targetSymbol = matched ? matched.symbol : resolveSymbolOrName(trim, searchStockList);
    handleSelect(targetSymbol, matched ? matched.name : getStockName(targetSymbol, trim));
  };

  // 랭킹 리스트 등 외부에서 externalSymbol을 바꿔주면(예: 카드 탭) 이 검색창도 동일한 종목을 강제로
  // 연다 - 이미 같은 종목이면 재조회하지 않도록 symbol과 비교한다(무한루프 방지).
  const pendingScrollRef = useRef(false);
  useEffect(() => {
    if (externalSymbol && externalSymbol !== symbol) {
      handleSelect(externalSymbol, getStockName(externalSymbol));
      pendingScrollRef.current = true; // 외부(랭킹 카드) 진입일 때만 자동 스크롤 대상으로 표시
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalSymbol]);

  const { data, isLoading } = useQuery<InvestorTrendResponse>({
    queryKey: ['investorTrend', symbol, '60d'],
    queryFn: () => fetchInvestorTrend(symbol),
    enabled: Boolean(symbol),
  });

  // 🚨 [버그 수정] 데이터가 아직 로딩 중일 때 스크롤하면 이후 SupplySummaryCards/뱃지/차트가 순차적으로
  // 부풀어 오르면서 페이지 높이가 계속 바뀌어 목표 위치가 어긋난다(실측 확인: rect.top이 -3975px로
  // 화면 밖에 위치). 데이터 로딩이 실제로 끝나(isLoading===false) 상세 콘텐츠가 다 그려진 뒤에
  // 스크롤한다 - useEffect는 브라우저 페인트 이후 실행되므로 이 시점엔 이미 DOM에 반영돼 있어
  // requestAnimationFrame으로 한 번 더 미룰 필요가 없다(실측 확인: rAF로 감싸면 백그라운드 탭에서
  // 콜백 자체가 실행되지 않아 스크롤이 전혀 발동하지 않는 경우가 있었음).
  useEffect(() => {
    if (pendingScrollRef.current && !isLoading && data) {
      pendingScrollRef.current = false;
      document.getElementById('mobile-stock-search-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isLoading, data]);

  return (
    <div id="mobile-stock-search-panel" className="w-full flex flex-col gap-3 scroll-mt-16">
      <div ref={wrapperRef} className="relative w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-3 shadow-sm">
        <form onSubmit={handleSubmit} className="relative flex items-center">
          <Search className="absolute left-3 w-4 h-4 text-slate-400 dark:text-[#787b86]" />
          <input
            value={inputVal}
            onChange={(e) => {
              setInputVal(e.target.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            placeholder="종목명 또는 6자리 코드"
            className="w-full pl-9 pr-8 py-2.5 rounded-lg bg-slate-50 dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-red-500/30"
          />
          {inputVal && (
            <button
              type="button"
              onClick={() => { setInputVal(''); setSymbol(''); setIsOpen(false); }}
              className="absolute right-2.5 p-0.5 text-slate-400"
              aria-label="지우기"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </form>

        {isOpen && filtered.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto bg-white dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] rounded-lg shadow-lg z-40">
            {filtered.map((s) => (
              <button
                key={s.symbol}
                type="button"
                onClick={() => handleSelect(s.symbol, s.name)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-[#2a2e39] border-b last:border-b-0 border-slate-100 dark:border-[#2a2e39]"
              >
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{s.name}</span>
                <span className="text-[11px] font-mono text-slate-400">{s.symbol} · {s.market}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {symbol && (
        <>
          {/* 전 탭 뱃지 모음 - 데스크톱 StockBadgeStrip.tsx를 그대로 재사용(수칙 1-6, 레이아웃이 이미
              반응형 flex라 모바일 폭에서도 그대로 wrap됨). 뱃지가 없으면 컴포넌트 자체가 null을
              반환해 아무것도 렌더링되지 않으므로(:empty), 감싸는 카드도 함께 숨긴다. */}
          <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-2 empty:hidden empty:border-0 empty:p-0">
            <StockBadgeStrip symbol={symbol} />
          </div>
          <SupplySummaryCards
            summary={data?.summary}
            programTrade={data?.programTrade}
            stockInfo={data?.stockInfo}
            isLoading={isLoading || !data}
          />
          <MobileStockDetailChart trend={data?.trend || []} stockInfo={data?.stockInfo} isLoading={isLoading || !data} />
        </>
      )}
    </div>
  );
}
