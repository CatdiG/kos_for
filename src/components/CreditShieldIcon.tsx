'use client';

import { ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react';

interface CreditShieldIconProps {
  isCreditAvailable?: boolean;
  className?: string;
}

// 신용가능 3-상태(가능/불가/미확인) 아이콘 - MobileStockDetailChart.tsx가 쓰던 3색 Shield 매핑을
// 그대로 재사용 가능한 형태로 뽑아냈다(수칙 1-6). 좁은 목록 행에 붙이는 용도라 라벨 텍스트 없이
// 아이콘 + 툴팁(title)만 노출한다 - 상세 패널의 라벨 달린 알약형 배지와는 배치 폭이 달라 그대로
// 공유하지 않고 아이콘 매핑만 공통화했다.
export default function CreditShieldIcon({ isCreditAvailable, className = 'w-3 h-3' }: CreditShieldIconProps) {
  if (isCreditAvailable === true) {
    return (
      <span title="신용가능" className="inline-flex shrink-0">
        <ShieldCheck className={`${className} text-emerald-500`} />
      </span>
    );
  }
  if (isCreditAvailable === false) {
    return (
      <span title="신용불가" className="inline-flex shrink-0">
        <ShieldOff className={`${className} text-slate-400`} />
      </span>
    );
  }
  return (
    <span title="신용 확인필요" className="inline-flex shrink-0">
      <ShieldQuestion className={`${className} text-amber-500`} />
    </span>
  );
}
