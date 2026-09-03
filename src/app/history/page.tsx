'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { HistoryRankingTable } from '@/components/history/HistoryRankingTable';
import { RankingType, RankingPeriod, MarketType, RankingDirection, RankingItem } from '@/lib/types';

type OverlapMode = 'daily' | 'consecutive2d' | 'consecutive3d';
type SurgingSubMode = 'fluctuation' | 'volume' | 'amount' | 'overlap';

interface DropoutItem {
  symbol: string;
  name: string;
  reason: string;
  currentPrice: number;
  changeRate: number;
  netBuyAmtEok: number;
  droppedFromDate: string;
  targetDays: 2 | 3;
}

// 단타 종합랭킹 가중치 - 라이브 대시보드(InvestorRankingTable.tsx)와 동일한 기본값/공식
const DEFAULT_WEIGHTS = { volInc: 50, amt: 20, fluc: 10, trendAlign: 5, closeStrength: 5, foreign: 5, organ: 5 };
type WeightKey = keyof typeof DEFAULT_WEIGHTS;

// KST(한국표준시) 기준 오늘 날짜를 'YYYY-MM-DD' 문자열로 반환한다 (서버 로직과 동일한 UTC+9 변환).
function getKstTodayDateStr(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function HistoryPage() {
  const [selectedDate, setSelectedDate] = useState(getKstTodayDateStr());
  const [activeTab, setActiveTab] = useState<RankingType>('foreign');
  const [market, setMarket] = useState<MarketType>('ALL');
  const [direction, setDirection] = useState<RankingDirection>('buy');
  const [period] = useState<RankingPeriod>('1d');
  const [overlapMode, setOverlapMode] = useState<OverlapMode>('daily');
  const [surgingMode, setSurgingMode] = useState<SurgingSubMode>('fluctuation');
  const [items, setItems] = useState<RankingItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastBatchTime, setLastBatchTime] = useState<string>('');
  const [fetchError, setFetchError] = useState<string>('');
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [showDropouts, setShowDropouts] = useState(false);
  const [dropoutItems, setDropoutItems] = useState<DropoutItem[]>([]);
  const [dropoutNote, setDropoutNote] = useState<string>('');
  const [isDropoutLoading, setIsDropoutLoading] = useState(false);

  const TABS: Array<{ id: RankingType; label: string }> = [
    { id: 'foreign', label: '외국인' },
    { id: 'organ', label: '기관' },
    { id: 'program', label: '프로그램' },
    { id: 'surging', label: '급등주' },
    { id: 'comprehensive', label: '단타 종합랭킹' },
    { id: 'overlap', label: '수급교집합' },
  ];

  const showDirectionToggle = activeTab !== 'surging' && activeTab !== 'comprehensive';
  const isComprehensive = activeTab === 'comprehensive';

  // 단타 종합랭킹 슬라이더 가중치로 재계산 - 라이브 대시보드와 동일한 하이브리드 비선형(RMS) 공식
  const displayItems = useMemo(() => {
    if (!isComprehensive) return items;

    const totalWeightSum = weights.fluc + weights.amt + weights.volInc + weights.foreign + weights.organ + weights.trendAlign + weights.closeStrength || 1;

    const recomputed = items.map((item) => {
      if (!item.scoreBreakdown) return item;
      const {
        flucScore, amtScore, volIncScore, foreignScore, organScore,
        trendAlignScore = 50, closeStrengthScore = 50,
      } = item.scoreBreakdown;

      const momSumW = weights.fluc + weights.volInc + weights.amt || 1;
      const confSumW = weights.trendAlign + weights.closeStrength + weights.foreign + weights.organ || 1;

      const momSqSum = weights.fluc * Math.pow(flucScore, 2) + weights.volInc * Math.pow(volIncScore, 2) + weights.amt * Math.pow(amtScore, 2);
      const momRmsScore = Math.sqrt(momSqSum / momSumW);

      const confLinearScore = (trendAlignScore * weights.trendAlign + closeStrengthScore * weights.closeStrength + foreignScore * weights.foreign + organScore * weights.organ) / confSumW;

      const momWeightRatio = momSumW / totalWeightSum;
      const confWeightRatio = confSumW / totalWeightSum;
      const dynamicTotal = Number((momRmsScore * momWeightRatio + confLinearScore * confWeightRatio).toFixed(1));

      return { ...item, scoreBreakdown: { ...item.scoreBreakdown, totalScore: dynamicTotal } };
    });

    return [...recomputed]
      .sort((a, b) => (b.scoreBreakdown?.totalScore || 0) - (a.scoreBreakdown?.totalScore || 0))
      .map((item, idx) => ({ ...item, rank: idx + 1 }));
  }, [items, isComprehensive, weights]);

  useEffect(() => {
    let isCancelled = false;

    async function fetchHistoryData() {
      setIsLoading(true);
      setFetchError('');
      try {
        const params = new URLSearchParams({
          date: selectedDate,
          type: activeTab,
          direction,
          period,
          market,
          limit: '50',
          _bust: String(Date.now()),
        });
        if (activeTab === 'overlap') params.set('mode', overlapMode);
        if (activeTab === 'surging') params.set('surgingMode', surgingMode);

        const res = await fetch(`/api/history/ranking?${params.toString()}`);
        if (res.ok) {
          const json = await res.json();
          if (!isCancelled) {
            setItems(json.list || []);
            setLastBatchTime(json.lastBatchTime || '');
            setFetchError(json.error || '');
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
  }, [selectedDate, activeTab, market, period, direction, overlapMode, surgingMode]);

  // 수급교집합 "이탈 종목" - 2일연속/3일연속 양쪽 다 조회해서 합쳐 보여준다(라이브 탭과 동일 방식)
  useEffect(() => {
    if (activeTab !== 'overlap' || !showDropouts) return;
    let isCancelled = false;

    async function fetchDropouts() {
      setIsDropoutLoading(true);
      try {
        const [res2, res3] = await Promise.all([
          fetch(`/api/history/overlap-dropouts?date=${selectedDate}&direction=${direction}&market=${market}&targetDays=2`),
          fetch(`/api/history/overlap-dropouts?date=${selectedDate}&direction=${direction}&market=${market}&targetDays=3`),
        ]);
        const [json2, json3] = await Promise.all([res2.json(), res3.json()]);
        if (isCancelled) return;
        const merged: DropoutItem[] = [
          ...(json2.list || []).map((i: any) => ({ ...i, targetDays: 2 as const })),
          ...(json3.list || []).map((i: any) => ({ ...i, targetDays: 3 as const })),
        ];
        setDropoutItems(merged);
        setDropoutNote(merged.length === 0 ? (json3.note || json2.note || '') : '');
      } catch (e) {
        console.error('[History Dropouts Fetch Error]', e);
      } finally {
        if (!isCancelled) setIsDropoutLoading(false);
      }
    }

    fetchDropouts();
    return () => { isCancelled = true; };
  }, [activeTab, showDropouts, selectedDate, direction, market]);

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

            {/* 매수/매도 선택 (급등주·단타종합랭킹은 방향 개념이 없어서 숨김 - 라이브 탭과 동일) */}
            {showDirectionToggle && (
              <div className="flex items-center bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl border border-slate-200 dark:border-slate-700 text-xs">
                {(['buy', 'sell'] as RankingDirection[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDirection(d)}
                    className={`px-3 py-1 rounded-lg font-medium transition-all ${
                      direction === d
                        ? d === 'buy'
                          ? 'bg-red-600 text-white shadow-sm font-bold'
                          : 'bg-blue-600 text-white shadow-sm font-bold'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    {d === 'buy' ? '순매수' : '순매도'}
                  </button>
                ))}
              </div>
            )}
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
        <div className="flex border-b border-slate-200 dark:border-slate-800 mb-3 overflow-x-auto gap-1">
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

        {/* 급등주 서브탭 (등락률/거래량/거래대금/급등주교집합) - 라이브 탭과 동일 구성 */}
        {activeTab === 'surging' && (
          <div className="flex items-center gap-1 mb-4 bg-orange-50 dark:bg-orange-950/30 p-1 rounded-xl border border-orange-200 dark:border-orange-900/40 w-fit text-xs">
            {([
              { id: 'fluctuation', label: '등락률 상위' },
              { id: 'volume', label: '거래량 상위' },
              { id: 'amount', label: '거래대금 상위' },
              { id: 'overlap', label: '급등주 교집합(3중)' },
            ] as Array<{ id: SurgingSubMode; label: string }>).map((m) => (
              <button
                key={m.id}
                onClick={() => setSurgingMode(m.id)}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all whitespace-nowrap ${
                  surgingMode === m.id
                    ? 'bg-orange-600 text-white shadow-sm'
                    : 'text-orange-700 dark:text-orange-300 hover:text-orange-900'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* 수급교집합 서브탭 (당일/2일연속/3일연속) - 라이브 탭과 동일 구성 */}
        {activeTab === 'overlap' && (
          <div className="flex items-center gap-1 mb-4 bg-purple-50 dark:bg-purple-950/30 p-1 rounded-xl border border-purple-200 dark:border-purple-900/40 w-fit text-xs">
            {([
              { id: 'daily', label: '당일 교집합' },
              { id: 'consecutive2d', label: '2일연속 교집합' },
              { id: 'consecutive3d', label: '3일연속 교집합' },
            ] as Array<{ id: OverlapMode; label: string }>).map((m) => (
              <button
                key={m.id}
                onClick={() => { setOverlapMode(m.id); setShowDropouts(false); }}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all whitespace-nowrap ${
                  overlapMode === m.id && !showDropouts
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                }`}
              >
                {m.label}
              </button>
            ))}
            <button
              onClick={() => setShowDropouts(true)}
              className={`px-3 py-1.5 rounded-lg font-bold transition-all whitespace-nowrap ${
                showDropouts
                  ? 'bg-slate-600 text-white shadow-sm'
                  : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
              }`}
              title="이 날짜 바로 이전 영업일 대비 2일연속/3일연속 명단에서 밀려난 종목을 봅니다"
            >
              이탈 종목
            </button>
          </div>
        )}

        {/* 단타 종합랭킹 가중치 슬라이더 패널 - 라이브 대시보드와 동일 구성 */}
        {isComprehensive && (
          <div className="mb-4 bg-gradient-to-r from-purple-900/5 via-indigo-900/5 to-blue-900/5 dark:from-purple-950/30 dark:via-indigo-950/30 dark:to-blue-950/30 border border-purple-200 dark:border-purple-900/40 rounded-2xl p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-bold text-slate-900 dark:text-white mr-1">가중치 프리셋:</span>
                <button onClick={() => setWeights(DEFAULT_WEIGHTS)} className="px-2.5 py-1 rounded-lg font-bold border bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-purple-50 dark:hover:bg-purple-950/40">⚖️ 기본 밸런스</button>
                <button onClick={() => setWeights({ fluc: 33, volInc: 33, amt: 34, foreign: 0, organ: 0, trendAlign: 0, closeStrength: 0 })} className="px-2.5 py-1 rounded-lg font-bold border bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/40">⚡ 모멘텀 3지표 집중</button>
                <button onClick={() => setWeights({ fluc: 10, volInc: 20, amt: 20, foreign: 25, organ: 25, trendAlign: 0, closeStrength: 0 })} className="px-2.5 py-1 rounded-lg font-bold border bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-blue-950/40">🌊 수급 확증형</button>
              </div>
              <button onClick={() => setWeights(DEFAULT_WEIGHTS)} className="text-[10px] px-2.5 py-1 rounded-lg bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 hover:bg-purple-200 font-bold border border-purple-200 dark:border-purple-800/50">초기화</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {([
                { key: 'volInc', label: '거래량', color: 'accent-red-500' },
                { key: 'amt', label: '거래대금', color: 'accent-orange-500' },
                { key: 'fluc', label: '등락률', color: 'accent-amber-500' },
                { key: 'trendAlign', label: '정배열추세', color: 'accent-emerald-500' },
                { key: 'closeStrength', label: '캔들강도', color: 'accent-rose-500' },
                { key: 'foreign', label: '외국인', color: 'accent-blue-500' },
                { key: 'organ', label: '기관', color: 'accent-purple-500' },
              ] as Array<{ key: WeightKey; label: string; color: string }>).map((w) => (
                <div key={w.key} className="bg-white/80 dark:bg-slate-900/60 p-2 rounded-xl border border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200 mb-1">
                    <span>{w.label}</span>
                    <span className="font-mono">{weights[w.key]}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights[w.key]}
                    onChange={(e) => setWeights({ ...weights, [w.key]: Number(e.target.value) })}
                    className={`w-full h-1.5 rounded-lg cursor-pointer ${w.color}`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {fetchError ? (
          <div className="mb-4 p-3 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-xs text-amber-700 dark:text-amber-400">
            ⚠️ {fetchError}
          </div>
        ) : null}

        {/* 이탈 종목 패널 - "이탈 종목" 버튼을 켜면 아래 순위표 대신 이것만 단독 표시 */}
        {activeTab === 'overlap' && showDropouts && (
          <>
            {/* 히스토리는 하루에 한 번 확정된 값만 저장하므로(장중 스냅샷을 따로 안 남김), 라이브 탭의
                "당일 이탈"(하루 안의 변화)은 개념 자체가 성립하지 않는다. 항상 "어제의 이탈"과 동일한
                방식(직전 영업일 대비 비교)만 가능하다는 걸 명확히 알려준다. */}
            <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-bold border border-indigo-200 dark:border-indigo-900/50">
                어제의 이탈 기준
              </span>
              <span>
                히스토리는 하루에 한 번 확정된 값만 보관해서, 라이브 탭의 "당일 이탈"(하루 안의 변화)은 계산할 수 없습니다.
                항상 직전 영업일 마감 대비 비교만 제공합니다.
              </span>
            </div>
          </>
        )}
        {activeTab === 'overlap' && showDropouts ? (
          isDropoutLoading ? (
            <div className="py-12 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
              이탈 종목 확인 중...
            </div>
          ) : dropoutItems.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
              {dropoutNote || '이탈한 종목이 없습니다.'}
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-800/40 text-slate-600 dark:text-slate-400 text-xs font-semibold">
                      <th className="py-3 px-4 min-w-[80px]">구분</th>
                      <th className="py-3 px-4 min-w-[160px]">종목명</th>
                      <th className="py-3 px-4 min-w-[220px]">이탈 이유</th>
                      <th className="py-3 px-4 text-right">현재가</th>
                      <th className="py-3 px-4 text-right">등락률</th>
                      <th className="py-3 px-4 text-right">직전 합산 순매수</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {dropoutItems.map((d) => {
                      const isPositive = d.changeRate > 0;
                      const isNegative = d.changeRate < 0;
                      return (
                        <tr key={`${d.targetDays}-${d.symbol}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="py-3 px-4">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${d.targetDays === 3 ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400'}`}>
                              {d.targetDays}일연속 이탈
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-semibold text-slate-900 dark:text-slate-100">{d.name}</span>
                            <span className="text-xs text-slate-400 ml-2">{d.symbol}</span>
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-400">{d.reason}</td>
                          <td className="py-3 px-4 text-right font-medium text-slate-800 dark:text-slate-200">{d.currentPrice.toLocaleString()}원</td>
                          <td className={`py-3 px-4 text-right font-semibold ${isPositive ? 'text-red-500 dark:text-red-400' : isNegative ? 'text-blue-500 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300'}`}>
                            {isPositive ? '+' : ''}{d.changeRate.toFixed(2)}%
                          </td>
                          <td className={`py-3 px-4 text-right font-bold ${d.netBuyAmtEok >= 0 ? 'text-red-500 dark:text-red-400' : 'text-blue-500 dark:text-blue-400'}`}>
                            {d.netBuyAmtEok > 0 ? '+' : ''}{d.netBuyAmtEok}억
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : (
          <HistoryRankingTable
            items={displayItems}
            type={activeTab}
            period={period}
            market={market}
            isLoading={isLoading}
            selectedDate={selectedDate}
            surgingMode={activeTab === 'surging' ? surgingMode : undefined}
            overlapMode={activeTab === 'overlap' ? overlapMode : undefined}
          />
        )}
      </main>
    </div>
  );
}
