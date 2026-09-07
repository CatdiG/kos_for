// 모바일 전용 대시보드 - 데스크톱 page.tsx와 동일하게 로직 없이 컴포넌트만 배치하는 얕은 컴포지션
// 패턴을 따른다. 데스크톱 page.tsx/컴포넌트는 전혀 건드리지 않았다.
'use client';

import { useState } from 'react';
import MobileHeader from '@/components/mobile/MobileHeader';
import MobileIndexCards from '@/components/mobile/MobileIndexCards';
import MobileIndexDetailChart from '@/components/mobile/MobileIndexDetailChart';
import MobileStockSearch from '@/components/mobile/MobileStockSearch';
import MobileRankingList from '@/components/mobile/MobileRankingList';

export default function MobileDashboardPage() {
  // 지수 카드 선택 상태 - 데스크톱 page.tsx의 selectedIndex와 동일한 패턴(수칙 1-6).
  const [selectedIndex, setSelectedIndex] = useState<'KOSPI' | 'KOSDAQ' | null>(null);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0b0e14] flex flex-col font-sans text-slate-900 dark:text-[#e0e3eb] transition-colors duration-200">
      <MobileHeader />

      <main className="flex-1 w-full mx-auto p-3 space-y-3 max-w-lg">
        <MobileIndexCards
          selected={selectedIndex}
          onSelect={(market) => setSelectedIndex((prev) => (prev === market ? null : market))}
        />
        {selectedIndex && (
          <MobileIndexDetailChart market={selectedIndex} onClose={() => setSelectedIndex(null)} />
        )}
        {/* 검색으로 연 종목 상세는 이 검색창 바로 아래에 표시된다. 매매순위 리스트에서 종목을 탭했을 때는
            (데스크톱 InvestorRankingTable.tsx와 동일하게) 그 카드 바로 아래에 별도로 펼쳐지므로 여기와
            연결할 필요가 없다 - MobileRankingList.tsx가 자체적으로 처리한다. */}
        <MobileStockSearch />
        <MobileRankingList />
      </main>

      <footer className="border-t border-slate-200 dark:border-[#2a2e39] py-3 px-4 text-center text-[10px] text-slate-400 dark:text-slate-500">
        한국투자증권(KIS) Open API 기반 수급 분석 · 모바일 버전
      </footer>
    </div>
  );
}
