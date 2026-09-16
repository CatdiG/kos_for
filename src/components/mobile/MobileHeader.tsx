'use client';

// 데스크톱 Header.tsx(129줄)의 모바일 축약판 - 로고/타이틀 한 줄 + 장 상태 배지 + 시계만 남기고 나머지는
// 압축했다. 장 상태 판정 로직은 Header.tsx의 getMarketStatus()와 동일한 기준(평일 09:00~15:30)을
// 그대로 재사용한다(수칙 1-6).
// 히스토리 페이지(/m/history)가 생기면서 "과거 수급 아카이브" 링크를 그쪽으로 연결한다. 데스크톱 전환
// 링크는 지금 보고 있는 화면(홈/히스토리)에 맞는 데스크톱 페이지로 가야 하므로 desktopHref prop으로
// 받는다(middleware.ts의 view=desktop 처리와 동일한 매핑 - 수칙 1-6).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, TrendingUp, Sun, Moon, History } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';

interface MobileHeaderProps {
  // 이 화면에 대응하는 데스크톱 경로 - "데스크톱" 버튼이 여기로 view=desktop과 함께 이동한다.
  desktopHref?: string;
}

// 🚨 [버그 수정 - 프로덕션 실측 React Hydration 에러 #418] now.getHours() 등 로컬 타임존 기반
// 함수를 그대로 쓰면, Vercel 서버(UTC 실행)와 사용자 브라우저(KST)의 계산 결과가 9시간 어긋나
// SSR·클라이언트 렌더 결과가 달라진다(로컬 dev는 서버·클라이언트가 같은 시스템 시간대라 재현
// 자체가 안 됐다) - Header.tsx와 동일하게 KST로 명시 변환한다(수칙 1-6).
function getMarketStatus() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const day = kst.getDay();
  const timeNum = kst.getHours() * 100 + kst.getMinutes();

  if (day === 0 || day === 6) {
    return { label: '주말 휴장', color: 'text-slate-600 dark:text-gray-400', dotColor: 'text-slate-400 dark:text-gray-500' };
  }
  if (timeNum >= 900 && timeNum < 1530) {
    return { label: '장중 실시간', color: 'text-emerald-600 dark:text-emerald-400', dotColor: 'text-emerald-600 dark:text-emerald-400' };
  }
  // 🚨 [버그 수정 - 애프터마켓 도입, Header.tsx와 동일 이유(수칙 1-6)] 실측: 19:33에도 "장마감"으로
  // 잘못 표시됐다 - 애프터마켓(16:00~20:00) 시간대는 별도 라벨로 구분한다.
  if (timeNum >= 1600 && timeNum < 2000) {
    return { label: '애프터마켓', color: 'text-sky-600 dark:text-sky-400', dotColor: 'text-sky-600 dark:text-sky-400' };
  }
  return { label: '장마감', color: 'text-indigo-600 dark:text-indigo-400', dotColor: 'text-indigo-600 dark:text-indigo-400' };
}

export default function MobileHeader({ desktopHref = '/' }: MobileHeaderProps) {
  const [timeStr, setTimeStr] = useState<string>('');
  // 🚨 [버그 수정 - 프로덕션 실측 React Hydration 에러 #418] KST 변환만으론 부족하다 - SSR 실행 순간과
  // 클라이언트 hydrate 순간 사이 시차가 마침 09:00/15:30/16:00/20:00 경계를 넘으면 여전히 어긋날 수
  // 있다. timeStr과 동일하게 초기값은 빈 값(서버·클라이언트 100% 일치)으로 두고 마운트 후에만 계산한다.
  const [marketStatus, setMarketStatus] = useState<{ label: string; color: string; dotColor: string }>({
    label: '',
    color: '',
    dotColor: '',
  });
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const update = () => {
      setTimeStr(new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }));
      setMarketStatus(getMarketStatus());
    };
    update();
    const id = setInterval(update, 1000 * 30);
    return () => clearInterval(id);
  }, []);

  const desktopToggleHref = `${desktopHref}${desktopHref.includes('?') ? '&' : '?'}view=desktop`;

  return (
    <header className="w-full bg-white dark:bg-[#131722] border-b border-slate-200 dark:border-[#2a2e39] px-3 py-2.5 sticky top-0 z-50 shadow-sm dark:shadow-none">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Link href="/m" className="w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-red-600 to-indigo-600 flex items-center justify-center">
            <TrendingUp className="w-4.5 h-4.5 text-white" />
          </Link>
          <div className="min-w-0">
            <h1 className="font-bold text-sm text-slate-900 dark:text-white leading-tight truncate">KIS 수급 분석</h1>
            <div className="flex items-center gap-1 text-[10px] font-medium">
              <Activity className={`w-3 h-3 ${marketStatus.dotColor}`} />
              <span className={marketStatus.color}>{marketStatus.label}</span>
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <span className="font-mono text-slate-500 dark:text-slate-400">{timeStr || '--:--'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Link
            href="/m/history"
            className="p-1.5 rounded-lg bg-slate-100 dark:bg-[#1e222d] border border-slate-200/60 dark:border-[#2a2e39] text-slate-500 dark:text-slate-400"
            title="과거 수급 아카이브"
            aria-label="과거 수급 아카이브"
          >
            <History className="w-3.5 h-3.5" />
          </Link>
          <Link
            href={desktopToggleHref}
            className="px-2 py-1.5 rounded-lg bg-slate-100 dark:bg-[#1e222d] text-[10px] font-semibold text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-[#2a2e39]"
          >
            데스크톱
          </Link>
          <button
            onClick={toggleTheme}
            type="button"
            aria-label="Toggle Theme"
            className="p-1.5 rounded-lg bg-slate-100 dark:bg-[#1e222d] border border-slate-200/60 dark:border-[#2a2e39] text-slate-600 dark:text-slate-300"
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-600" />}
          </button>
        </div>
      </div>
    </header>
  );
}
