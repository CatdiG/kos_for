'use client';

// 데스크톱 InvestorRankingTable.tsx(2163줄)의 넓은 <table> 대신, 375px 화면에 맞는 세로 카드 리스트로
// 매매순위를 보여준다. 탭 구성(6개: 급등주/단타종합랭킹/외국인/기관/프로그램/수급교집합), 시장 필터,
// 신용가능 필터, 수급교집합의 당일/2일/3일 서브모드 + 이탈 종목 추적, 단타 종합랭킹 가중치 슬라이더까지
// 데스크톱과 동일 기능을 카드형 레이아웃으로 재구현했다. API 엔드포인트/계산 공식은 데스크톱과 완전히
// 동일(/api/stock/ranking, /api/stock/surging, /api/stock/consecutive-overlap-dropouts) - 새 백엔드
// 불필요, 가중치 재계산 공식도 InvestorRankingTable.tsx 380~443번 줄을 그대로 이식했다(수칙 1-6).
//
// 🚨 [기능 보강] 사용자가 "데스크탑이랑 다른거 다 확인해"라고 지적한 뒤 InvestorRankingTable.tsx를 다시
// 정독해 아래 항목이 빠져있었음을 확인하고 추가했다:
//   1. 종목 카드를 탭하면 그 카드 바로 아래에 상세가 펼쳐져야 하는데(데스크톱 2006번 줄 expandedSymbols
//      아코디언), 지난 수정에서는 잘못 짐작해서 위쪽 검색창을 강제로 여는 방식으로 만들었다 - 폐기하고
//      MobileStockDetailPanel을 카드 바로 아래에 렌더링하는 진짜 아코디언으로 교체.
//   2. 급등주 탭 서브탭(등락률/거래량/거래대금/교집합, 데스크톱 900~953번 줄) - surgingMode state 자체가
//      없어서 항상 등락률 고정이었다. 신규 추가.
//   3. 기간 필터(당일/1주일/1개월, 데스크톱 843~863번 줄) - period가 '1d'로 하드코딩돼 있었다. 신규 추가.
//   4. 수급교집합 "진입가능만" 필터(entryReadyOnly, 데스크톱 505~518번 줄, 1248~1263번 줄) - 신규 추가.
//   5. 수급교집합 카드의 AI Pick 별 마크(aiPickRank, 데스크톱 1597번 줄) - 신규 추가(모바일 카드 폭에
//      맞춰 이모지로 단순화).

import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  InvestorRankingResponse,
  MarketType,
  RankingDirection,
  RankingItem,
  RankingPeriod,
  RankingType,
  SurgingMode,
} from '@/lib/types';
import { Rocket, Trophy, Globe2, Landmark, Cpu, Flame, ShieldCheck, ArrowUpDown, TrendingDown, RotateCcw, TrendingUp, Coins, Filter, ChevronDown, ChevronUp } from 'lucide-react';
import MobileStockDetailPanel from './MobileStockDetailPanel';

async function fetchRanking(
  type: RankingType,
  direction: RankingDirection,
  period: RankingPeriod,
  mode: 'daily' | 'consecutive2d' | 'consecutive3d',
  market: MarketType
): Promise<InvestorRankingResponse> {
  const res = await fetch(
    `/api/stock/ranking?type=${type}&direction=${direction}&period=${period}&mode=${mode}&limit=50&market=${market}`
  );
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '매매 순위 데이터를 가져오는 중 오류가 발생했습니다.');
  }
  return res.json();
}

async function fetchSurging(mode: string, market: MarketType): Promise<InvestorRankingResponse> {
  const res = await fetch(`/api/stock/surging?mode=${mode}&market=${market}`);
  if (!res.ok) throw new Error('급등주 데이터를 가져오는 중 오류가 발생했습니다.');
  return res.json();
}

interface DropoutItem {
  symbol: string;
  name: string;
  reason: string;
  netBuyAmtEok?: number;
  currentPrice?: number;
  netBuyQty?: number;
  netBuyAmt?: number;
  changeRate?: number;
  droppedAt?: string;
  targetDays: 2 | 3;
}

async function fetchDropouts(direction: RankingDirection, market: MarketType, scope: 'today' | 'yesterday'): Promise<{ list: DropoutItem[] }> {
  const [res2, res3] = await Promise.all([
    fetch(`/api/stock/consecutive-overlap-dropouts?direction=${direction}&market=${market}&targetDays=2&scope=${scope}`),
    fetch(`/api/stock/consecutive-overlap-dropouts?direction=${direction}&market=${market}&targetDays=3&scope=${scope}`),
  ]);
  if (!res2.ok || !res3.ok) throw new Error('이탈 종목 데이터를 가져오는 중 오류가 발생했습니다.');
  const [json2, json3] = await Promise.all([res2.json(), res3.json()]);
  const list2: DropoutItem[] = (json2.list || []).map((d: any) => ({ ...d, targetDays: 2 as const }));
  const list3: DropoutItem[] = (json3.list || []).map((d: any) => ({ ...d, targetDays: 3 as const }));
  const merged = [...list2, ...list3].sort((a, b) => new Date(b.droppedAt || 0).getTime() - new Date(a.droppedAt || 0).getTime());
  return { list: merged };
}

const TABS: { id: RankingType; label: string; icon: any; badge?: string }[] = [
  { id: 'surging', label: '급등주', icon: Rocket, badge: 'LIVE' },
  { id: 'comprehensive', label: '단타종합', icon: Trophy, badge: 'SCORE' },
  { id: 'foreign', label: '외국인', icon: Globe2 },
  { id: 'organ', label: '기관', icon: Landmark },
  { id: 'program', label: '프로그램', icon: Cpu },
  { id: 'overlap', label: '수급교집합', icon: Flame, badge: 'HOT' },
];

// 데스크톱 InvestorRankingTable.tsx 908~950번 줄과 동일한 4개 서브탭.
const SURGING_MODES: { id: SurgingMode; label: string; icon: any }[] = [
  { id: 'fluctuation', label: '등락률', icon: Rocket },
  { id: 'volume', label: '거래량', icon: TrendingUp },
  { id: 'amount', label: '거래대금', icon: Coins },
  { id: 'overlap', label: '급등주 교집합', icon: Flame },
];

// InvestorRankingTable.tsx 354~364번 줄과 동일한 기본 프리셋(합계 100%).
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

// InvestorRankingTable.tsx 380~443번 줄과 100% 동일한 하이브리드 RMS 가중치 재계산 공식 - 슬라이더가
// 움직일 때마다 새 API 호출 없이, 이미 받아온 scoreBreakdown(지표별 개별 점수)을 그대로 재조합한다.
function applyWeights(list: RankingItem[], weights: Weights): RankingItem[] {
  const totalWeightSum = weights.fluc + weights.amt + weights.volInc + weights.foreign + weights.organ + weights.trendAlign + weights.closeStrength || 1;
  const recalculated = list.map((item) => {
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
  return recalculated
    .sort((a, b) => (b.scoreBreakdown?.totalScore || 0) - (a.scoreBreakdown?.totalScore || 0))
    .map((item, idx) => ({ ...item, rank: idx + 1 }));
}

function formatEok(v: number | undefined) {
  if (v === undefined) return '-';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString()}억`;
}

// 데스크톱 1597~1668번 줄의 AI Pick 별 배지를 모바일 카드 폭에 맞춰 이모지 한 글자로 단순화.
const AI_PICK_EMOJI: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉', 4: '⭐', 5: '⭐' };

// 수급교집합 카드 서브라인 - 데스크톱 1721~1783번 줄(statusBadge + ranksByType)을 한 줄로 압축.
function buildOverlapSubLine(item: RankingItem, overlapMode: 'daily' | 'consecutive2d' | 'consecutive3d'): string {
  const parts: string[] = [];
  if (item.statusBadge) parts.push(item.statusBadge);
  (item.ranksByType || []).forEach((r) => {
    const text = overlapMode !== 'daily'
      ? (r.consecutiveText || (r.consecutiveDays && r.consecutiveDays >= 2 ? `${r.consecutiveDays}일연속` : '당일'))
      : (r.isRanked === false || !r.rank || r.rank <= 0 ? '순위밖' : `${r.rank}위`);
    parts.push(`${r.label} ${text}`);
  });
  return parts.join(' · ') || item.investorBadge || '-';
}

function RankingCard({ item, activeTab, overlapMode, isExpanded, onClick }: { item: RankingItem; activeTab: RankingType; overlapMode: 'daily' | 'consecutive2d' | 'consecutive3d'; isExpanded: boolean; onClick?: () => void }) {
  const isUp = item.change >= 0;
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2.5 bg-white dark:bg-[#131722] border rounded-xl active:bg-slate-50 dark:active:bg-[#1a1e2a] cursor-pointer transition-colors ${
        isExpanded ? 'border-blue-400 dark:border-blue-600 ring-1 ring-blue-400/40' : 'border-slate-200 dark:border-[#2a2e39]'
      }`}
    >
      <div className="w-6 shrink-0 text-center text-xs font-bold text-slate-400 dark:text-slate-500 relative">
        {activeTab === 'overlap' && item.aiPickRank && item.aiPickRank <= 5 && (
          <span className="absolute -top-2 -left-1.5 text-[10px] leading-none" title={`AI 수급 추천 ${item.aiPickRank}위`}>
            {AI_PICK_EMOJI[item.aiPickRank]}
          </span>
        )}
        {item.rank}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-slate-900 dark:text-white truncate">{item.name}</span>
          <span className="text-[10px] font-mono text-slate-400 shrink-0">{item.symbol}</span>
          {item.isCreditAvailable && <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />}
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
          {activeTab === 'overlap'
            ? buildOverlapSubLine(item, overlapMode)
            : activeTab === 'surging'
            ? `${item.surgingBadge ? `${item.surgingBadge} · ` : ''}거래대금 ${(item.amountEok || 0).toLocaleString()}억`
            : activeTab === 'comprehensive'
            ? `종합점수 ${item.scoreBreakdown?.totalScore ?? '-'}점`
            : `순매수 ${formatEok(item.netBuyAmtEok)}`}
        </div>
      </div>
      <div className="text-right shrink-0 flex items-center gap-1.5">
        <div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white">{item.currentPrice?.toLocaleString()}</div>
          <div className={`text-[11px] font-mono font-semibold ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
            {isUp ? '+' : ''}{item.changeRate?.toFixed(2)}%
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-blue-500 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 shrink-0" />}
      </div>
    </div>
  );
}

function DropoutCard({ item, rank }: { item: DropoutItem; rank: number }) {
  const changeRate = item.changeRate || 0;
  const isUp = changeRate >= 0;
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl">
      <div className="w-6 shrink-0 text-center text-xs font-bold text-slate-400 dark:text-slate-500">{rank}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-slate-900 dark:text-white truncate">{item.name}</span>
          <span className="text-[10px] font-mono text-slate-400 shrink-0">{item.symbol}</span>
          <span className="text-[9px] px-1 py-0.5 rounded font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">{item.targetDays}일연속 이탈</span>
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">{item.reason || '-'}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-bold text-slate-900 dark:text-white">{item.currentPrice?.toLocaleString() ?? '-'}</div>
        <div className={`text-[11px] font-mono font-semibold ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
          {isUp ? '+' : ''}{changeRate.toFixed(2)}%
        </div>
      </div>
    </div>
  );
}

export default function MobileRankingList() {
  const [activeTab, setActiveTab] = useState<RankingType>('surging');
  const [direction, setDirection] = useState<RankingDirection>('buy');
  const [period, setPeriod] = useState<RankingPeriod>('1d');
  const [surgingMode, setSurgingMode] = useState<SurgingMode>('fluctuation');
  const [overlapMode, setOverlapMode] = useState<'daily' | 'consecutive2d' | 'consecutive3d'>('daily');
  const [market, setMarket] = useState<MarketType>('ALL');
  const [creditOnly, setCreditOnly] = useState(false);
  const [entryReadyOnly, setEntryReadyOnly] = useState(false);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [showWeightPanel, setShowWeightPanel] = useState(false);
  const [showDropouts, setShowDropouts] = useState(false);
  const [dropoutScope, setDropoutScope] = useState<'today' | 'yesterday'>('today');
  // 카드를 탭하면 그 카드 바로 아래에 상세를 펼친다(데스크톱 InvestorRankingTable.tsx의 expandedSymbols
  // 아코디언과 동일하게 한 번에 1개만 펼침).
  const [expandedSymbol, setExpandedSymbol] = useState<string>('');

  const isSurging = activeTab === 'surging' || activeTab === 'comprehensive';
  const isComprehensive = activeTab === 'comprehensive';

  const { data, isLoading, isError } = useQuery<InvestorRankingResponse>({
    queryKey: isSurging
      ? ['m-surging', activeTab === 'comprehensive' ? 'comprehensive' : surgingMode, market]
      : ['m-ranking', activeTab, direction, period, overlapMode, market],
    queryFn: () =>
      isSurging
        ? fetchSurging(activeTab === 'comprehensive' ? 'comprehensive' : surgingMode, market)
        : fetchRanking(activeTab, direction, period, overlapMode, market),
    staleTime: 30 * 1000,
    // 🚨 [버그 수정] 프로그램 탭이 콜드스타트 직후(더미 시그니처가 섞인 stillWarming:true 상태)일 때
    // 데스크톱(InvestorRankingTable.tsx:121)은 50초마다 자동 재조회해서 예열이 끝나는 대로 화면이
    // 저절로 채워지는데, 모바일엔 이 폴링이 없어 그 상태로 영원히 멈춰 있었다(새로고침해야만 나아짐) -
    // 사용자 지적("다른 탭들이 안떠")의 실제 원인.
    refetchInterval: (query) => {
      const d = query.state.data as InvestorRankingResponse | undefined;
      if (d?.isPartial) return 4 * 1000;
      if (activeTab === 'program' && d?.stillWarming) return 50 * 1000;
      return false;
    },
  });

  const { data: dropoutData, isLoading: isDropoutLoading, isError: isDropoutError } = useQuery<{ list: DropoutItem[] }>({
    queryKey: ['m-dropouts', direction, market, dropoutScope],
    queryFn: () => fetchDropouts(direction, market, dropoutScope),
    enabled: showDropouts && activeTab === 'overlap',
    staleTime: 30 * 1000,
    refetchInterval: showDropouts ? 30 * 1000 : false,
  });

  // 탭/서브모드/시장/방향/기간이 바뀌면 펼쳐둔 카드와 필터를 초기화한다(데스크톱 543~601번 줄의
  // handleTabChange 등과 동일한 정책 - 다른 목록으로 전환됐는데 이전 필터가 그대로 남아있으면 혼란스럽다).
  useEffect(() => {
    setExpandedSymbol('');
    setCreditOnly(false);
    setEntryReadyOnly(false);
  }, [activeTab, surgingMode, market, direction, period, overlapMode]);

  let list = data?.list || [];
  // 데스크톱 494~503번 줄과 동일: 필터로 걸러진 뒤에는 순위를 1,2,3...으로 다시 매긴다(원래 순위가
  // 듬성듬성 남아있으면 "3위 다음이 7위"처럼 보여 혼란스럽다).
  if (creditOnly) {
    list = list.filter((i) => i.isCreditAvailable).map((item, idx) => ({ ...item, rank: idx + 1 }));
  }
  // 데스크톱 505~518번 줄과 동일: 이격도 배지가 단기과열 또는 역배열인 종목을 교집합 탭에서 제외.
  if (activeTab === 'overlap' && entryReadyOnly) {
    list = list
      .filter((i) => {
        const badge = i.statusBadge || '';
        return !badge.includes('단기과열') && !badge.includes('역배열');
      })
      .map((item, idx) => ({ ...item, rank: idx + 1 }));
  }
  if (isComprehensive) list = applyWeights(list, weights);

  return (
    <div className="flex flex-col gap-2.5">
      {/* 6개 탭 */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => { setActiveTab(t.id); if (t.id !== 'overlap') setShowDropouts(false); }}
              className={`flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition ${
                isActive
                  ? 'bg-red-600 text-white border-red-600'
                  : 'bg-white dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              {t.badge && <span className={`text-[9px] ${isActive ? 'text-white/80' : 'text-slate-400'}`}>{t.badge}</span>}
            </button>
          );
        })}
      </div>

      {/* 급등주 서브탭(등락률/거래량/거래대금/교집합) */}
      {activeTab === 'surging' && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {SURGING_MODES.map((m) => {
            const Icon = m.icon;
            const isActive = surgingMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setSurgingMode(m.id)}
                className={`flex items-center gap-1 shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                  isActive
                    ? m.id === 'overlap'
                      ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white border-transparent'
                      : 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-300 dark:border-red-800'
                    : 'bg-white dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'
                }`}
              >
                <Icon className="w-3 h-3" />
                {m.label}
              </button>
            );
          })}
        </div>
      )}

      {/* 시장 필터 + 기간 필터 + 신용가능 + (수급주체 탭이면) 매수/매도 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg">
          {(['ALL', 'KOSPI', 'KOSDAQ'] as MarketType[]).map((m) => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={`px-2 py-1 rounded-md text-[11px] font-bold transition ${
                market === m ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {m === 'ALL' ? '전체' : m === 'KOSPI' ? '코스피' : '코스닥'}
            </button>
          ))}
        </div>
        {/* 기간 필터(당일/1주일/1개월) - 데스크톱 843~863번 줄과 동일하게 급등주/단타종합 탭에서는 숨김 */}
        {!isSurging && (
          <div className="flex bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg">
            {(['1d', '1w', '1m'] as RankingPeriod[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2 py-1 rounded-md text-[11px] font-bold transition ${
                  period === p ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {p === '1d' ? '당일' : p === '1w' ? '1주일' : '1개월'}
              </button>
            ))}
          </div>
        )}
        {!isSurging && (
          <button
            onClick={() => setDirection((d) => (d === 'buy' ? 'sell' : 'buy'))}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-slate-300"
          >
            <ArrowUpDown className="w-3 h-3" />
            {direction === 'buy' ? '순매수' : '순매도'}
          </button>
        )}
        {!showDropouts && (
          <button
            onClick={() => setCreditOnly((v) => !v)}
            className={`px-2 py-1 rounded-lg text-[11px] font-bold border transition ${
              creditOnly ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39]'
            }`}
          >
            신용가능만
          </button>
        )}
        {/* 진입가능만 필터 - 데스크톱 1248~1263번 줄과 동일, 교집합 탭 전용 */}
        {activeTab === 'overlap' && !showDropouts && (
          <button
            onClick={() => setEntryReadyOnly((v) => !v)}
            title="이격도 배지가 '단기과열' 또는 '역배열'인 종목을 목록에서 제외합니다"
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border transition ${
              entryReadyOnly ? 'bg-emerald-600 text-white border-transparent' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39]'
            }`}
          >
            <Filter className="w-3 h-3" />
            진입가능만
          </button>
        )}
      </div>

      {/* 수급교집합 서브모드 + 이탈 종목 */}
      {activeTab === 'overlap' && (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="flex bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg w-fit">
              {([
                { id: 'daily', label: '당일' },
                { id: 'consecutive2d', label: '2일연속' },
                { id: 'consecutive3d', label: '3일연속' },
              ] as const).map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setOverlapMode(m.id); setShowDropouts(false); }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition ${
                    overlapMode === m.id && !showDropouts ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowDropouts(true)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                showDropouts ? 'bg-gradient-to-r from-slate-600 to-slate-700 text-white border-transparent' : 'bg-slate-50 dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'
              }`}
              title="2일연속/3일연속 명단에서 오늘 밀려난 종목과 사유를 봅니다"
            >
              <TrendingDown className="w-3 h-3" />
              이탈 종목
            </button>
          </div>

          {showDropouts && (
            <div className="flex bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg w-fit">
              {([
                { id: 'today', label: '당일 이탈' },
                { id: 'yesterday', label: '어제의 이탈' },
              ] as const).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setDropoutScope(s.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition ${
                    dropoutScope === s.id ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* 단타 종합랭킹 가중치 패널 */}
      {isComprehensive && (
        <div className="bg-gradient-to-r from-purple-900/5 via-indigo-900/5 to-blue-900/5 dark:from-purple-950/30 dark:via-indigo-950/30 dark:to-blue-950/30 border border-purple-200 dark:border-purple-800/50 rounded-xl p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-1.5">
            <button
              onClick={() => setShowWeightPanel((v) => !v)}
              className="flex items-center gap-1 text-xs font-bold text-slate-900 dark:text-white"
            >
              <Trophy className="w-3.5 h-3.5 text-amber-500" />
              가중치 프리셋 {showWeightPanel ? '▲' : '▼'}
            </button>
            <button
              onClick={() => setWeights(DEFAULT_WEIGHTS)}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-bold"
            >
              <RotateCcw className="w-3 h-3" />
              초기화
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {WEIGHT_PRESETS.map((p) => {
              const isActive = JSON.stringify(p.weights) === JSON.stringify(weights);
              return (
                <button
                  key={p.key}
                  onClick={() => setWeights(p.weights)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                    isActive ? `${p.activeColor} text-white` : 'bg-white/80 dark:bg-[#131722]/80 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39]'
                  }`}
                >
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
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights[s.key]}
                    onChange={(e) => setWeights({ ...weights, [s.key]: Number(e.target.value) })}
                    className={`w-full h-1.5 rounded-lg cursor-pointer ${s.accent}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 리스트 */}
      {activeTab === 'overlap' && showDropouts ? (
        isDropoutLoading ? (
          <div className="py-10 text-center text-slate-400 text-xs">이탈 종목 확인 중...</div>
        ) : isDropoutError ? (
          <div className="py-10 text-center text-red-500 text-xs">이탈 종목 데이터를 가져오지 못했습니다.</div>
        ) : !dropoutData?.list || dropoutData.list.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-xs">
            {dropoutScope === 'yesterday' ? '직전 영업일 마감 대비 이탈한 종목이 없습니다.' : '아직 오늘 이탈한 종목이 없습니다.'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {dropoutData.list.map((item, idx) => (
              <DropoutCard key={`${item.symbol}-${item.targetDays}`} item={item} rank={idx + 1} />
            ))}
          </div>
        )
      ) : isLoading ? (
        <div className="py-10 text-center text-slate-400 text-xs">불러오는 중...</div>
      ) : isError ? (
        <div className="py-10 text-center text-red-500 text-xs">데이터를 가져오지 못했습니다.</div>
      ) : list.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-xs">조건에 맞는 종목이 없습니다.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((item) => {
            const isExpanded = expandedSymbol === item.symbol;
            return (
              <React.Fragment key={item.symbol}>
                <RankingCard
                  item={item}
                  activeTab={activeTab}
                  overlapMode={overlapMode}
                  isExpanded={isExpanded}
                  onClick={() => setExpandedSymbol((prev) => (prev === item.symbol ? '' : item.symbol))}
                />
                {isExpanded && (
                  <div className="pl-1 pr-0.5 -mt-1">
                    <MobileStockDetailPanel symbol={item.symbol} />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
