// 모바일 전용 과거 수급 아카이브 - 데스크톱 history/page.tsx(483줄)의 상태/fetch 로직을 그대로 이식하고
// (동일 API 엔드포인트: /api/history/ranking, /api/history/overlap-dropouts - 새 백엔드 불필요, 수칙
// 1-6), <table> 렌더링만 MobileHistoryRankingList(카드형)로 교체했다. 가중치 슬라이더/이탈종목 로직은
// MobileRankingList.tsx가 이미 쓰는 것과 동일한 패턴(공식은 데스크톱 history/page.tsx 67~98번 줄과
// 100% 동일)이다.
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import MobileHeader from '@/components/mobile/MobileHeader';
import MobileHistoryRankingList from '@/components/mobile/MobileHistoryRankingList';
import { RankingType, RankingPeriod, MarketType, RankingDirection, RankingItem } from '@/lib/types';
import { RotateCcw, Trophy, TrendingDown } from 'lucide-react';

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

const DEFAULT_WEIGHTS = { volInc: 50, amt: 20, fluc: 10, trendAlign: 5, closeStrength: 5, foreign: 5, organ: 5 };
type Weights = typeof DEFAULT_WEIGHTS;

const WEIGHT_PRESETS: { key: string; label: string; weights: Weights; activeColor: string }[] = [
  { key: 'balance', label: '⚖️ 기본 밸런스', weights: DEFAULT_WEIGHTS, activeColor: 'bg-purple-600 border-purple-600' },
  { key: 'momentum', label: '⚡ 모멘텀 집중', weights: { fluc: 33, volInc: 33, amt: 34, foreign: 0, organ: 0, trendAlign: 0, closeStrength: 0 }, activeColor: 'bg-gradient-to-r from-red-600 to-amber-600 border-red-600' },
  { key: 'supply', label: '🌊 수급 확증형', weights: { fluc: 10, volInc: 20, amt: 20, foreign: 25, organ: 25, trendAlign: 0, closeStrength: 0 }, activeColor: 'bg-blue-600 border-blue-600' },
];

const WEIGHT_SLIDERS: { key: keyof Weights; label: string; color: string; accent: string }[] = [
  { key: 'fluc', label: '등락률', color: 'text-red-500', accent: 'accent-red-500' },
  { key: 'volInc', label: '거래량', color: 'text-amber-500', accent: 'accent-amber-500' },
  { key: 'amt', label: '거래대금', color: 'text-yellow-600', accent: 'accent-yellow-500' },
  { key: 'trendAlign', label: '정배열추세', color: 'text-emerald-500', accent: 'accent-emerald-500' },
  { key: 'closeStrength', label: '캔들강도', color: 'text-cyan-500', accent: 'accent-cyan-500' },
  { key: 'foreign', label: '외국인', color: 'text-purple-500', accent: 'accent-purple-500' },
  { key: 'organ', label: '기관', color: 'text-indigo-500', accent: 'accent-indigo-500' },
];

function getKstTodayDateStr(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const TABS: { id: RankingType; label: string }[] = [
  { id: 'foreign', label: '외국인' },
  { id: 'organ', label: '기관' },
  { id: 'program', label: '프로그램' },
  { id: 'surging', label: '급등주' },
  { id: 'comprehensive', label: '단타종합' },
  { id: 'overlap', label: '수급교집합' },
];

function DropoutCard({ item }: { item: DropoutItem }) {
  const isUp = item.changeRate > 0;
  const isDown = item.changeRate < 0;
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-slate-900 dark:text-white truncate">{item.name}</span>
          <span className="text-[10px] font-mono text-slate-400 shrink-0">{item.symbol}</span>
          <span className="text-[9px] px-1 py-0.5 rounded font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">{item.targetDays}일연속 이탈</span>
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">{item.reason || '-'}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-bold text-slate-900 dark:text-white">{item.currentPrice.toLocaleString()}</div>
        <div className={`text-[11px] font-mono font-semibold ${isUp ? 'text-red-600 dark:text-red-500' : isDown ? 'text-blue-600 dark:text-blue-500' : 'text-slate-500'}`}>
          {isUp ? '+' : ''}{item.changeRate.toFixed(2)}%
        </div>
      </div>
    </div>
  );
}

export default function MobileHistoryPage() {
  const [selectedDate, setSelectedDate] = useState(getKstTodayDateStr());
  const [activeTab, setActiveTab] = useState<RankingType>('foreign');
  const [market, setMarket] = useState<MarketType>('ALL');
  const [direction, setDirection] = useState<RankingDirection>('buy');
  const [period] = useState<RankingPeriod>('1d');
  const [overlapMode, setOverlapMode] = useState<OverlapMode>('daily');
  const [surgingMode, setSurgingMode] = useState<SurgingSubMode>('fluctuation');
  const [items, setItems] = useState<RankingItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastBatchTime, setLastBatchTime] = useState('');
  const [fetchError, setFetchError] = useState('');
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [showWeightPanel, setShowWeightPanel] = useState(false);
  const [showDropouts, setShowDropouts] = useState(false);
  const [dropoutItems, setDropoutItems] = useState<DropoutItem[]>([]);
  const [dropoutNote, setDropoutNote] = useState('');
  const [isDropoutLoading, setIsDropoutLoading] = useState(false);

  const showDirectionToggle = activeTab !== 'surging' && activeTab !== 'comprehensive';
  const isComprehensive = activeTab === 'comprehensive';

  // 가중치 재계산 - history/page.tsx 67~98번 줄과 100% 동일한 하이브리드 RMS 공식.
  const displayItems = useMemo(() => {
    if (!isComprehensive) return items;
    const totalWeightSum = weights.fluc + weights.amt + weights.volInc + weights.foreign + weights.organ + weights.trendAlign + weights.closeStrength || 1;
    const recomputed = items.map((item) => {
      if (!item.scoreBreakdown) return item;
      const { flucScore, amtScore, volIncScore, foreignScore, organScore, trendAlignScore = 50, closeStrengthScore = 50 } = item.scoreBreakdown;
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
          date: selectedDate, type: activeTab, direction, period, market, limit: '50', _bust: String(Date.now()),
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
        console.error('[Mobile History Page Fetch Error]', e);
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    }
    fetchHistoryData();
    return () => { isCancelled = true; };
  }, [selectedDate, activeTab, market, period, direction, overlapMode, surgingMode]);

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
        console.error('[Mobile History Dropouts Fetch Error]', e);
      } finally {
        if (!isCancelled) setIsDropoutLoading(false);
      }
    }
    fetchDropouts();
    return () => { isCancelled = true; };
  }, [activeTab, showDropouts, selectedDate, direction, market]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0b0e14] flex flex-col font-sans text-slate-900 dark:text-[#e0e3eb]">
      <MobileHeader desktopHref="/history" />

      <main className="flex-1 w-full mx-auto p-3 space-y-3 max-w-lg">
        {/* 안내 배너 */}
        <div className="p-2.5 rounded-xl border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/50 dark:bg-indigo-950/20">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">📜 {selectedDate} 확정 원본 데이터 기반 랭킹</p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">이미 마감된 확정 데이터베이스 기반 1회 계산 정적 아카이브입니다.</p>
          {lastBatchTime && <p className="text-[10px] text-slate-400 mt-1">{lastBatchTime}</p>}
        </div>

        {/* 날짜 + 시장 필터 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-[#2a2e39] bg-white dark:bg-[#1e222d] text-slate-800 dark:text-slate-100 outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
          <div className="flex bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg">
            {(['ALL', 'KOSPI', 'KOSDAQ'] as MarketType[]).map((m) => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={`px-2 py-1 rounded-md text-[11px] font-bold transition ${market === m ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
              >
                {m === 'ALL' ? '전체' : m === 'KOSPI' ? '코스피' : '코스닥'}
              </button>
            ))}
          </div>
          {showDirectionToggle && (
            <button
              onClick={() => setDirection((d) => (d === 'buy' ? 'sell' : 'buy'))}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${direction === 'buy' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'}`}
            >
              {direction === 'buy' ? '순매수' : '순매도'}
            </button>
          )}
        </div>

        {/* 6개 탭 */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setActiveTab(t.id); if (t.id !== 'overlap') setShowDropouts(false); }}
              className={`shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition ${
                activeTab === t.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 급등주 서브탭 */}
        {activeTab === 'surging' && (
          <div className="flex bg-orange-50 dark:bg-orange-950/30 p-0.5 rounded-lg w-fit flex-wrap">
            {([
              { id: 'fluctuation', label: '등락률' },
              { id: 'volume', label: '거래량' },
              { id: 'amount', label: '거래대금' },
              { id: 'overlap', label: '교집합' },
            ] as { id: SurgingSubMode; label: string }[]).map((m) => (
              <button
                key={m.id}
                onClick={() => setSurgingMode(m.id)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition ${surgingMode === m.id ? 'bg-orange-600 text-white' : 'text-orange-700 dark:text-orange-300'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* 수급교집합 서브탭 + 이탈종목 */}
        {activeTab === 'overlap' && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="flex bg-purple-50 dark:bg-purple-950/30 p-0.5 rounded-lg w-fit">
              {([
                { id: 'daily', label: '당일' },
                { id: 'consecutive2d', label: '2일연속' },
                { id: 'consecutive3d', label: '3일연속' },
              ] as { id: OverlapMode; label: string }[]).map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setOverlapMode(m.id); setShowDropouts(false); }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition ${overlapMode === m.id && !showDropouts ? 'bg-purple-600 text-white' : 'text-purple-700 dark:text-purple-300'}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowDropouts(true)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${showDropouts ? 'bg-gradient-to-r from-slate-600 to-slate-700 text-white border-transparent' : 'bg-slate-50 dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'}`}
            >
              <TrendingDown className="w-3 h-3" />
              이탈 종목
            </button>
          </div>
        )}

        {/* 단타 종합랭킹 가중치 패널 */}
        {isComprehensive && (
          <div className="bg-gradient-to-r from-purple-900/5 via-indigo-900/5 to-blue-900/5 dark:from-purple-950/30 dark:via-indigo-950/30 dark:to-blue-950/30 border border-purple-200 dark:border-purple-800/50 rounded-xl p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-1.5">
              <button onClick={() => setShowWeightPanel((v) => !v)} className="flex items-center gap-1 text-xs font-bold text-slate-900 dark:text-white">
                <Trophy className="w-3.5 h-3.5 text-amber-500" />
                가중치 프리셋 {showWeightPanel ? '▲' : '▼'}
              </button>
              <button onClick={() => setWeights(DEFAULT_WEIGHTS)} className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-bold">
                <RotateCcw className="w-3 h-3" />
                초기화
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {WEIGHT_PRESETS.map((p) => {
                const isActive = JSON.stringify(p.weights) === JSON.stringify(weights);
                return (
                  <button key={p.key} onClick={() => setWeights(p.weights)} className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${isActive ? `${p.activeColor} text-white` : 'bg-white/80 dark:bg-[#131722]/80 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39]'}`}>
                    {p.label}
                  </button>
                );
              })}
            </div>
            {showWeightPanel && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                {WEIGHT_SLIDERS.map((s) => (
                  <div key={s.key} className="bg-white/90 dark:bg-[#131722]/90 p-2 rounded-lg border border-slate-200 dark:border-[#2a2e39] space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-700 dark:text-slate-200">
                      <span className={s.color}>{s.label}</span>
                      <span className="font-mono">{weights[s.key]}%</span>
                    </div>
                    <input type="range" min="0" max="100" step="5" value={weights[s.key]} onChange={(e) => setWeights({ ...weights, [s.key]: Number(e.target.value) })} className={`w-full h-1.5 rounded-lg cursor-pointer ${s.accent}`} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {fetchError && (
          <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 text-[11px] text-amber-700 dark:text-amber-400">
            ⚠️ {fetchError}
          </div>
        )}

        {/* 이탈 종목 or 순위 리스트 */}
        {activeTab === 'overlap' && showDropouts ? (
          <>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 px-1">
              <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 font-bold border border-indigo-200 dark:border-indigo-900/50 mr-1">어제의 이탈 기준</span>
              히스토리는 하루에 한 번 확정된 값만 보관해 직전 영업일 마감 대비 비교만 제공합니다.
            </div>
            {isDropoutLoading ? (
              <div className="py-10 text-center text-slate-400 text-xs">이탈 종목 확인 중...</div>
            ) : dropoutItems.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs">{dropoutNote || '이탈한 종목이 없습니다.'}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {dropoutItems.map((d) => (
                  <DropoutCard key={`${d.targetDays}-${d.symbol}`} item={d} />
                ))}
              </div>
            )}
          </>
        ) : (
          <MobileHistoryRankingList
            items={displayItems}
            type={activeTab}
            isLoading={isLoading}
            selectedDate={selectedDate}
            overlapMode={activeTab === 'overlap' ? overlapMode : undefined}
            surgingMode={activeTab === 'surging' ? surgingMode : undefined}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-[#2a2e39] py-3 px-4 text-center text-[10px] text-slate-400 dark:text-slate-500">
        한국투자증권(KIS) Open API 기반 수급 분석 · 과거 수급 아카이브
      </footer>
    </div>
  );
}
