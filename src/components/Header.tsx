'use client';

import React, { useEffect, useState } from 'react';
import { Activity, ShieldCheck, Database, Clock, TrendingUp, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';

export default function Header() {
  const [timeStr, setTimeStr] = useState<string>('');
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
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // 장중 상태 판단 (평일 09:00 ~ 15:30)
  const getMarketStatus = () => {
    const now = new Date();
    const day = now.getDay();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const timeNum = hours * 100 + minutes;

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
    } else {
      return {
        label: '장마감 (종가 반영)',
        color: 'text-indigo-600 dark:text-indigo-400',
        dotColor: 'text-indigo-600 dark:text-indigo-400',
      };
    }
  };

  const marketStatus = getMarketStatus();

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
              외국인 / 기관 / 연기금 / 프로그램 수급 실시간 종합 랭킹
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
