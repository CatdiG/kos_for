'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ShieldCheck, Clock, TrendingUp, Sun, Moon, History } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';

// 평일 09:00~15:30(정규장)/16:00~20:00(애프터마켓) 기준 KST 장 상태 판단 - Header.tsx/MobileHeader.tsx
// 공용(수칙 1-6). 반드시 KST로 명시 변환해서 계산해야 한다 - Vercel 서버는 UTC로 실행되는데
// now.getHours() 등 로컬 타임존 기반 함수를 그대로 쓰면 SSR(서버=UTC)과 클라이언트(브라우저=KST) 사이에
// "장중"/"장마감" 결과가 9시간 어긋나게 계산돼 React Hydration 에러(#418)를 낸다(실측: 프로덕션
// 배포 후 콘솔에서 발견 - 로컬 dev는 서버·클라이언트가 같은 시스템 시간대라 재현이 아예 안 됐다).
function getMarketStatus() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const day = kst.getDay();
  const timeNum = kst.getHours() * 100 + kst.getMinutes();

  if (day === 0 || day === 6) {
    return {
      label: '주말 휴장',
      color: 'text-slate-600 dark:text-gray-400',
      dotColor: 'bg-slate-400 dark:bg-gray-500',
    };
  }

  if (timeNum >= 900 && timeNum < 1530) {
    return {
      label: '장중 실시간 반영 중',
      color: 'text-emerald-600 dark:text-emerald-400',
      dotColor: 'text-emerald-600 dark:text-emerald-400',
    };
  }
  // 🚨 [버그 수정 - 사용자 지적: "그 전에는 애프터마켓이 없었어서 다 15시30분에 멈춘걸거야"] 2026-09-14
  // KRX 애프터마켓(16:00~20:00, 실시간 체결) 도입 전에는 15:30 이후를 전부 "장마감"으로 표시해도
  // 맞았지만, 지금은 19시대에도 실거래가 진행 중인데 "장마감"이라고 잘못 표시되고 있었다(실측:
  // 모바일 헤더가 19:33에도 "장마감"). kisApi.ts의 getDynamicRankingTtl() 등과 동일한 경계(수칙 1-6).
  if (timeNum >= 1600 && timeNum < 2000) {
    return {
      label: '애프터마켓 실시간 반영 중',
      color: 'text-sky-600 dark:text-sky-400',
      dotColor: 'text-sky-600 dark:text-sky-400',
    };
  }
  return {
    label: '장마감 (종가 반영)',
    color: 'text-indigo-600 dark:text-indigo-400',
    dotColor: 'text-indigo-600 dark:text-indigo-400',
  };
}

export default function Header() {
  const [timeStr, setTimeStr] = useState<string>('');
  // 🚨 [버그 수정 - 프로덕션 실측 React Hydration 에러 #418] 위 KST 변환만으로는 부족하다 - SSR이
  // 실행되는 순간과 클라이언트가 hydrate하는 순간 사이에도 수 초~수십 초 시차가 있어, 마침 그 사이에
  // 09:00/15:30/16:00/20:00 경계를 넘으면 여전히 서버·클라이언트 결과가 어긋날 수 있다. timeStr과
  // 완전히 동일한 패턴(초기값은 빈 값으로 서버·클라이언트 100% 일치, 실제 계산은 마운트 후 useEffect
  // 에서만)으로 통일해 근본적으로 차단한다.
  const [marketStatus, setMarketStatus] = useState<{ label: string; color: string; dotColor: string }>({
    label: '',
    color: '',
    dotColor: '',
  });
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(
        now.toLocaleTimeString('ko-KR', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
      setMarketStatus(getMarketStatus());
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="w-full bg-white dark:bg-[#131722] border-b border-slate-200 dark:border-[#2a2e39] px-4 py-3 sticky top-0 z-50 shadow-sm dark:shadow-none transition-colors duration-200">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Logo & Title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-indigo-600 flex items-center justify-center shadow-md shadow-red-500/20">
            <TrendingUp className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg text-slate-900 dark:text-white tracking-wide">
                KIS 주식 수급 분석 시스템
              </h1>
              <span className="text-[10px] px-2 py-0.5 rounded font-mono font-semibold bg-red-50 dark:bg-red-950/80 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/50">
                PRO DEMAND
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">
              외국인 / 기관 / 프로그램 수급 실시간 종합 랭킹
            </p>
          </div>
        </div>

        {/* Live Status Indicators */}
        <div className="flex items-center gap-2.5 sm:gap-4 flex-wrap justify-center">
          {/* Real API Status Badge */}
          <div className="flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 px-3 py-1.5 rounded-xl text-xs font-semibold text-emerald-700 dark:text-emerald-300 shadow-xs">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>한투 KIS OpenAPI 실시간</span>
          </div>

          {/* Market Open Status */}
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-[#1e222d] border border-slate-200/60 dark:border-[#2a2e39] px-3 py-1.5 rounded-xl text-xs font-medium text-slate-700 dark:text-slate-200">
            <Activity className={`w-3.5 h-3.5 ${marketStatus.dotColor}`} />
            <span className={marketStatus.color}>{marketStatus.label}</span>
          </div>

          {/* Clock */}
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-[#1e222d] border border-slate-200/60 dark:border-[#2a2e39] px-3 py-1.5 rounded-xl text-xs font-mono font-bold text-slate-700 dark:text-slate-200">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span>{timeStr || '09:00:00'}</span>
          </div>

          {/* 과거 수급 아카이브(/history) 페이지 진입 링크 - 이전엔 인앱 링크가 전혀 없어서 URL을
              직접 쳐야만 접근 가능했다. /history 페이지도 이미 "← 실시간 탭으로 이동"으로 여기로
              돌아오는 링크가 있으니, 반대 방향도 대칭으로 연결한다. */}
          <Link
            href="/history"
            className="flex items-center gap-1.5 bg-slate-100 dark:bg-[#1e222d] border border-slate-200/60 dark:border-[#2a2e39] px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-[#2a2e39] transition"
          >
            <History className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span>과거 수급 아카이브</span>
          </Link>

          {/* Theme Toggle Switch */}
          <button
            onClick={toggleTheme}
            type="button"
            className="p-2 rounded-xl bg-slate-100 dark:bg-[#1e222d] border border-slate-200/60 dark:border-[#2a2e39] text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
            aria-label="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-600" />}
          </button>
        </div>
      </div>
    </header>
  );
}
