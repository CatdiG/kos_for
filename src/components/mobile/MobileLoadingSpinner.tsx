'use client';

// 모바일 전용 로딩 표시 공통 컴포넌트 - 예전엔 6개 파일(MobileRankingList/MobileIndexCards/
// MobileIndexDetailChart/MobileIntraday3mChart/MobileStockDetailChart/MobileHistoryRankingList)이
// 전부 "py-10 text-center text-slate-400 text-xs" 텍스트만 있는 동일한 로딩 블록을 각자 중복
// 구현하고 있었다(수칙 1-6 위반). 사용자 지적("불러오는중에서 계속 멈춰있지 않아보이게 로딩 표시해줘")을
// 반영해 도는 원(spinner)을 추가한 단일 공통 컴포넌트로 통합한다.
import { Loader2 } from 'lucide-react';

export default function MobileLoadingSpinner({ label }: { label: string }) {
  return (
    <div className="py-10 flex flex-col items-center justify-center gap-2 text-slate-400 dark:text-slate-500 text-xs">
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
