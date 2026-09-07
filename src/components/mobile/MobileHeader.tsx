'use client';

// 데스크톱 Header.tsx(129줄)의 모바일 축약판 - 로고/타이틀 한 줄 + 장 상태 배지 + 시계만 남기고 나머지는
// 압축했다. 장 상태 판정 로직은 Header.tsx의 getMarketStatus()와 동일한 기준(평일 09:00~15:30)을
// 그대로 재사용한다(수칙 1-6).
// 히스토리 페이지(/m/history)가 생기면서 "과거 수급 아카이브" 링크를 그쪽으로 연결한다. 데스크톱 전환
// 링크는 지금 보고 있는 화면(홈/히스토리)에 맞는 데스크톱 페이지로 가야 하므로 desktopHref prop으로
// 받는다(middleware.ts의 view=desktop 처리와 동일한 매핑 - 수칙 1-6).

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, TrendingUp, Sun, Moon, History } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';

interface MobileHeaderProps {
  // 이 화면에 대응하는 데스크톱 경로 - "데스크톱" 버튼이 여기로 view=desktop과 함께 이동한다.
  desktopHref?: string;
}

function getMarketStatus() {
  const now = new Date();
  const day = now.getDay();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeNum = hours * 100 + minutes;

  if (day === 0 || day === 6) {
    return { label: '주말 휴장', color: 'text-slate-600 dark:text-gray-400', dotColor: 'text-slate-400 dark:text-gray-500' };
  }
  if (timeNum >= 900 && timeNum < 1530) {
    return { label: '장중 실시간', color: 'text-emerald-600 dark:text-emerald-400', dotColor: 'text-emerald-600 dark:text-emerald-400' };
  }
  return { label: '장마감', color: 'text-indigo-600 dark:text-indigo-400', dotColor: 'text-indigo-600 dark:text-indigo-400' };
}

export default function MobileHeader({ desktopHref = '/' }: MobileHeaderProps) {
  const [timeStr, setTimeStr] = useState<string>('');
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const update = () => setTimeStr(new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }));
    update();
    const id = setInterval(update, 1000 * 30);
    return () => clearInterval(id);
  }, []);

  const marketStatus = getMarketStatus();
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
