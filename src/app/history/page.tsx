'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { HistoryRankingTable } from '@/components/history/HistoryRankingTable';
import { RankingType, RankingPeriod, MarketType, RankingItem } from '@/lib/types';

export default function HistoryPage() {
  const [selectedDate, setSelectedDate] = useState('2026-08-28');
  const [activeTab, setActiveTab] = useState<RankingType>('foreign');
  const [market, setMarket] = useState<MarketType>('ALL');
  const [period, setPeriod] = useState<RankingPeriod>('1d');
  const [items, setItems] = useState<RankingItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastBatchTime, setLastBatchTime] = useState<string>('');

  const TABS: Array<{ id: RankingType; label: string }> = [
    { id: 'foreign', label: '외국인' },
    { id: 'organ', label: '기관' },
    { id: 'pension', label: '연기금' },
    { id: 'program', label: '프로그램' },
    { id: 'surging', label: '급등주' },
    { id: 'comprehensive', label: '단타 종합랭킹' },
    { id: 'overlap', label: '수급교집합' },
  ];

  useEffect(() => {
    let isCancelled = false;

    async function fetchHistoryData() {
      setIsLoading(true);
      try {
        const url = `/api/history/ranking?date=${selectedDate}&type=${activeTab}&period=${period}&market=${market}&limit=50&_bust=${Date.now()}`;
        const res = await fetch(url);
        if (res.ok) {
          const json = await res.json();
          if (!isCancelled) {
            setItems(json.list || []);
            setLastBatchTime(json.lastBatchTime || '');
          }
        }
      } catch (e) {
        console.error('[History Page Fetch Error]', e);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchHistoryData();

    return () => {
      isCancelled = true;
    };
  }, [selectedDate, activeTab, market, period]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-16">
      {/* 상단 네비게이션 헤더 */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span>실시간 탭으로 이동</span>
            </Link>
            <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <h1 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400">
              📜 과거 수급 아카이브
            </h1>
          </div>

          {/* 상단 날짜 선택기 & 시장 선택 컨트롤 */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl border border-slate-200 dark:border-slate-700">
              <span className="text-xs font-medium px-2 text-slate-500 dark:text-slate-400">조회일자:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* 시장 선택 (전체/코스피/코스닥) */}
            <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl border border-slate-200 dark:border-slate-700 text-xs">
              {(['ALL', 'KOSPI', 'KOSDAQ'] as MarketType[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  className={`px-3 py-1 rounded-lg font-medium transition-all ${
                    market === m
                      ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm font-bold'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {m === 'ALL' ? '전체' : m}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* 메인 컨텐츠 영역 */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        {/* 안내 배너 */}
        <div className="mb-6 p-4 rounded-xl border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/50 dark:bg-indigo-950/20 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xl">🗄️</span>
            <div>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                {selectedDate} 확정 원본 데이터 기반 랭킹
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                이미 마감된 확정 데이터베이스(`raw_daily_data`)를 기반으로 1회 계산 후 디스크에 영구 보관된 정적 아카이브입니다.
              </p>
            </div>
          </div>
          {lastBatchTime ? (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
              {lastBatchTime}
            </span>
          ) : null}
        </div>

        {/* 탭 바 */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 mb-6 overflow-x-auto gap-1">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-2.5 px-4 text-sm font-semibold whitespace-nowrap border-b-2 transition-all ${
                  isActive
                    ? 'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400 font-bold'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* 랭킹 테이블 렌더링 */}
        <HistoryRankingTable
          items={items}
          type={activeTab}
          period={period}
          market={market}
          isLoading={isLoading}
          selectedDate={selectedDate}
        />
      </main>
    </div>
  );
}
