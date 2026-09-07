'use client';

// 데스크톱 StockSearch.tsx의 모바일판 - 키보드 방향키 탐색 등 데스크톱 전용 상호작용은 빼고, 탭으로
// 결과를 고르는 터치 친화적 드롭다운만 남긴다. 검색 사전(buildSearchStockList/resolveSymbolOrName)은
// StockSearch.tsx가 쓰는 것과 동일한 걸 그대로 import해서 재사용한다(수칙 1-6, 새 검색 로직 금지).
// 종목 선택 시 종목 상세는 공통 컴포넌트 MobileStockDetailPanel에 위임한다.
//
// 🚨 [설계 정정] 이전엔 매매순위 리스트(MobileRankingList) 카드를 눌렀을 때 이 검색창을 강제로 열고
// 화면을 여기까지 스크롤시키는 방식으로 만들었는데, 실제 데스크톱은 그렇지 않았다 - 데스크톱
// InvestorRankingTable.tsx는 클릭한 행 바로 아래에 아코디언으로 상세를 펼친다(2006번 줄
// expandedSymbols). 그래서 랭킹 카드 클릭 대응 로직(externalSymbol/onSymbolChange, 자동 스크롤)을
// 전부 제거하고 MobileRankingList.tsx가 스스로 카드 아래에 펼치도록 옮겼다 - 이 검색창은 데스크톱
// StockSearch.tsx처럼 "검색으로 선택했을 때만" 자기 아래에 상세를 보여주는 원래 역할로 되돌린다.
import React, { useState } from 'react';
import { Search, X } from 'lucide-react';
import { PRESET_STOCKS, TOP_50_STOCKS } from '@/lib/mockData';
import { buildSearchStockList, getStockName, resolveSymbolOrName } from '@/lib/stockDictionary';
import MobileStockDetailPanel from './MobileStockDetailPanel';

export default function MobileStockSearch() {
  const [inputVal, setInputVal] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [symbol, setSymbol] = useState<string>('');

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
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trim = inputVal.trim();
    if (!trim) return;
    const matched = searchStockList.find((s) => s.name.toLowerCase() === trim.toLowerCase() || s.symbol === trim);
    const targetSymbol = matched ? matched.symbol : resolveSymbolOrName(trim, searchStockList);
    handleSelect(targetSymbol, matched ? matched.name : getStockName(targetSymbol, trim));
  };

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="relative w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-3 shadow-sm">
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

      {symbol && <MobileStockDetailPanel symbol={symbol} />}
    </div>
  );
}
