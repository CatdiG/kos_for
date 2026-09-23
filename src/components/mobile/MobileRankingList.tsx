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

import React, { useEffect, useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  InvestorRankingResponse,
  MarketType,
  RankingDirection,
  RankingItem,
  RankingPeriod,
  RankingType,
  SurgingMode,
} from '@/lib/types';
import { Rocket, Trophy, Globe2, Landmark, Cpu, Flame, ShieldCheck, ArrowUpDown, TrendingDown, RotateCcw, TrendingUp, Coins, Filter, ChevronDown, ChevronUp, Target, Zap, RefreshCw, Compass, Radar, Star } from 'lucide-react';
import MobileStockDetailPanel from './MobileStockDetailPanel';
import MobileLoadingSpinner from './MobileLoadingSpinner';
import { getSupabaseBrowserClient } from '@/lib/supabaseBrowserClient';
import { fetchReclaimWatchSignals, ReclaimWatchSignal, computeReclaimFreshnessInfo } from '@/lib/vwapReclaimClient';
import { VwapReclaimSignal, PivotReclaimSignal } from '@/lib/types';

// 🚨 [기능 추가 - 사용자 요청: "모바일에는 장마감 후보군 업데이트한거 안뜨던데"] 데스크톱 InvestorRankingTable.tsx
// 595~604번 줄(postmarket 최상위 탭)과 동일한 값 그대로 이식(수칙 1-6, 새 타입/새 API 만들지 않음).
type OverlapMode = 'daily' | 'consecutive2d' | 'consecutive3d';

async function fetchRanking(
  type: RankingType,
  direction: RankingDirection,
  period: RankingPeriod,
  mode: OverlapMode,
  market: MarketType,
  // 🚨 [기능 재설계 - "토글 필터로 진행해줘"] mode(기준 탭)와 독립된 쿼리 파라미터 - 데스크톱
  // InvestorRankingTable.tsx·route.ts와 동일한 이름/의미(수칙 1-6).
  quietFilter: boolean = false
): Promise<InvestorRankingResponse> {
  const res = await fetch(
    `/api/stock/ranking?type=${type}&direction=${direction}&period=${period}&mode=${mode}&limit=50&market=${market}${quietFilter ? '&quietFilter=1' : ''}`
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

// 🚨 [순서 변경 - 사용자 요청: "급등주 뒤에 관심종목, 그 뒤에 장마감 후보군", 데스크톱과 동일(수칙 1-6), 2026-09-23]
const TABS: { id: RankingType; label: string; icon: any; badge?: string }[] = [
  { id: 'surging', label: '급등주', icon: Rocket, badge: 'LIVE' },
  // 🚨 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "당연하지 모바일도 데스크탑이랑 볼수있는
  // 탭과 차트는 같아야지"] 종목 상세의 "실시간" 토글로 등록한 관심종목(ws_watchlist, 오라클 웹소켓
  // 브릿지 구독 대상과 동일 목록) 현재가 탭.
  { id: 'watchlist', label: '관심종목', icon: Star },
  // 🚨 [기능 통합 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로"] 데스크톱
  // InvestorRankingTable.tsx와 동일하게 급등/발굴/전조 3개 탭을 화면엔 하나로 합친다.
  { id: 'postmarket', label: '장마감 후보군', icon: Target, badge: 'NEW' },
  { id: 'comprehensive', label: '단타종합', icon: Trophy, badge: 'SCORE' },
  { id: 'foreign', label: '외국인', icon: Globe2 },
  { id: 'organ', label: '기관', icon: Landmark },
  { id: 'program', label: '프로그램', icon: Cpu },
  { id: 'overlap', label: '수급교집합', icon: Flame, badge: 'HOT' },
];

// 🚨 [순서 변경 - 사용자 요청: "급등주 교집합을 제일 앞으로", 데스크톱과 동일(수칙 1-6), 2026-09-23]
const SURGING_MODES: { id: SurgingMode; label: string; icon: any }[] = [
  { id: 'overlap', label: '급등주 교집합', icon: Flame },
  { id: 'fluctuation', label: '등락률', icon: Rocket },
  { id: 'volume', label: '거래량', icon: TrendingUp },
  { id: 'amount', label: '거래대금', icon: Coins },
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

// 수급교집합 카드 서브라인 - 데스크톱 1721~1789번 줄(statusBadge + ranksByType + "장마감 후보만" 토글
// 전용 역발상 지표)을 한 줄 텍스트로 압축.
function buildOverlapSubLine(item: RankingItem, overlapMode: OverlapMode, quietAccumFilter: boolean): string {
  const parts: string[] = [];
  if (item.statusBadge) parts.push(item.statusBadge);
  (item.ranksByType || []).forEach((r) => {
    const text = overlapMode !== 'daily'
      ? (r.consecutiveText || (r.consecutiveDays && r.consecutiveDays >= 2 ? `${r.consecutiveDays}일연속` : '당일'))
      : (r.isRanked === false || !r.rank || r.rank <= 0 ? '순위밖' : `${r.rank}위`);
    parts.push(`${r.label} ${text}`);
  });
  // 🚨 [기능 재설계 - "장마감 후보만" 토글] 데스크톱과 동일한 역발상 지표(종가위치·거래량배율·5일누적
  // 수익률 - 셋 다 낮을수록 좋음, kisApi.ts의 applyQuietAccumulationFilter 주석 참고)를 텍스트로 이어붙인다.
  if (quietAccumFilter && item.closePositionPct !== undefined) {
    parts.push(`종가위치 ${item.closePositionPct}% · 거래량 ${item.volRatioPct}%`);
  }
  if (quietAccumFilter && item.cum5dReturnPct !== undefined) {
    parts.push(`5일누적 ${item.cum5dReturnPct >= 0 ? '+' : ''}${item.cum5dReturnPct}%`);
  }
  return parts.join(' · ') || item.investorBadge || '-';
}

function RankingCard({ item, activeTab, overlapMode, quietAccumFilter, pivotSignal, pivotWatchActive, isExpanded, onClick, isWsWatchlisted, wsWatchlistToggling, onToggleWsWatchlist }: { item: RankingItem; activeTab: RankingType; overlapMode: OverlapMode; quietAccumFilter: boolean; pivotSignal?: PivotReclaimSignal; pivotWatchActive: boolean; isExpanded: boolean; onClick?: () => void; isWsWatchlisted: boolean; wsWatchlistToggling: boolean; onToggleWsWatchlist: () => void }) {
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
        {/* 🚨 [버그 수정 - 사용자 지적: "뱃지 겹치잖아. 안겹치게 예쁘게 만들어"] flex-wrap이 없어서
            종목명+코드+별+방패+감시신호 배지가 넘치면 줄바꿈 없이 오른쪽 가격 영역과 겹쳤다. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-bold text-slate-900 dark:text-white truncate">{item.name}</span>
          <span className="text-[10px] font-mono text-slate-400 shrink-0">{item.symbol}</span>
          {/* 🚨 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "모바일도 데스크탑이랑 같아야지"]
              관심종목 추가/제거 별 토글 - 카드 자체의 onClick(아코디언 펼침)과 겹치지 않게 막는다. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleWsWatchlist(); }}
            disabled={wsWatchlistToggling}
            title={isWsWatchlisted ? '관심종목에서 제거' : '관심종목에 추가 (실시간 웹소켓 감시)'}
            className={`shrink-0 cursor-pointer disabled:opacity-40 ${isWsWatchlisted ? 'text-amber-500' : 'text-slate-300 dark:text-slate-600'}`}
          >
            <Star className="w-3.5 h-3.5" fill={isWsWatchlisted ? 'currentColor' : 'none'} />
          </button>
          {item.isCreditAvailable && <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />}
          {/* 🚨 [기능 재설계 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "번개로고가 vwap인거 아니야? 그게
              나오지 말고 피봇에 녹아들어서 점수를 내야하는거라고" - "지금 로고별로 나오잖아"] VWAP 독립
              배지(번개 아이콘)를 전부 제거했다. VWAP는 R1/R2 정렬 우선순위의 동점 타이브레이커로만
              녹아든다(getMobileWatchPriority 참고) - 화면엔 별도 아이콘으로 다시 드러나지 않는다. */}
          {pivotWatchActive && (item as any).vwapOriginalRank !== undefined && (
            <span className="text-[9px] text-slate-400 dark:text-slate-500 font-normal whitespace-nowrap shrink-0">
              (원래 {(item as any).vwapOriginalRank}위)
            </span>
          )}
          {/* 🎯 [기능 추가 - 데스크톱과 동일] R2가 걸려있으면 R2를(더 강한 신호), 아니면 R1을 표시. */}
          {pivotSignal && (() => {
            // 🚨 [재설계 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "박스권 하락, 박스권 돌파 이런걸
            // 원했던건데... 순위표 배지로"] R1/R2와 무관한 순수 가격 흐름 신호(priceLeg)를 최우선으로.
            if (pivotSignal.priceLeg?.type === 'up') {
              return (
                <span
                  className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60 flex items-center gap-0.5"
                  title="순수 가격 흐름만으로 판단: 박스권을 재돌파하며 상승 중입니다 - R1/R2 여부와 무관"
                >
                  <Target className="w-2.5 h-2.5" />
                  박스권재돌파(+{pivotSignal.priceLeg.changePct}%)
                </span>
              );
            }
            if (pivotSignal.priceLeg?.type === 'down') {
              return (
                <span
                  className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/60 flex items-center gap-0.5"
                  title="순수 가격 흐름만으로 판단: 고점을 찍고 하락 중입니다 - R1/R2 여부와 무관"
                >
                  <Target className="w-2.5 h-2.5" />
                  박스권 하락({pivotSignal.priceLeg.changePct}%)
                </span>
              );
            }
            if (pivotSignal.priceLeg?.type === 'box') {
              return (
                <span
                  className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 flex items-center gap-0.5"
                  title="순수 가격 흐름만으로 판단: 최근 고점·저점이 반복해서 좁은 범위 안에 갇혀 횡보 중입니다 - R1/R2 여부와 무관"
                >
                  <Target className="w-2.5 h-2.5" />
                  박스권 유지(±{(pivotSignal.priceLeg.changePct / 2).toFixed(2)}%)
                </span>
              );
            }
            // 🚨 [버그 수정 - 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"] holding도 포함.
            const level: 'R2' | 'R1' | null =
              pivotSignal.r2.approaching || pivotSignal.r2.reclaimed || pivotSignal.r2.holding ? 'R2'
              : pivotSignal.r1.approaching || pivotSignal.r1.reclaimed || pivotSignal.r1.holding ? 'R1'
              : pivotSignal.r2.sellPressureWarning ? 'R2'
              : pivotSignal.r1.sellPressureWarning ? 'R1'
              : pivotSignal.r2.hadPriorBreak ? 'R2'
              : pivotSignal.r1.hadPriorBreak ? 'R1' : null;
            if (!level) return null;
            const sig = level === 'R2' ? pivotSignal.r2 : pivotSignal.r1;
            // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?", 데스크톱과 동일(수칙 1-6)]
            // 🚨 [버그 수정 - 사용자 지적: "뱃지 겹치잖아", 데스크톱과 동일(수칙 1-6)] 배지 문구 안에
            // 이어 붙이지 않고 별도 작은 텍스트로 분리해서 flex-wrap이 필요할 때 줄바꿈하게 한다.
            const crossLabel = sig.crossCount >= 2 ? `${sig.crossCount}번째 시도` : '';
            const crossLabelSpan = crossLabel ? (
              <span className="text-[8px] text-slate-400 dark:text-slate-500 font-normal shrink-0">
                {crossLabel}
              </span>
            ) : null;
            if (sig.approaching) {
              return (
                <span
                  className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/40 flex items-center gap-0.5 animate-pulse"
                  title={`${level}을(를) 뚫었다가 눌린 뒤 다시 ${level}로 접근 중, 거래량도 붙는 중`}
                >
                  <Target className="w-2.5 h-2.5" />
                  {level} 임박
                </span>
              );
            }
            // 🎯 [기능 추가 - 데스크톱과 동일(수칙 1-6)] 거래량은 늘었지만 매도 우위라 임박에서 제외됨.
            if (sig.sellPressureWarning) {
              return (
                <span
                  className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-rose-50 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400 border-rose-200 dark:border-rose-800/50 flex items-center gap-0.5"
                  title={`${level} 간격이 좁혀지고 거래량도 늘었지만, 그 거래량이 매도 우위입니다 - 재돌파 임박으로 보지 않습니다(참고용)`}
                >
                  <Target className="w-2.5 h-2.5" />
                  {level} 매도 압박
                </span>
              );
            }
            // 🎯 [기능 추가 - 데스크톱과 동일(수칙 1-6)] 처음 뚫은 뒤 한 번도 안 내려가고 계속 유지 중.
            if (sig.holding && sig.elapsedMs != null) {
              const info = computeReclaimFreshnessInfo(sig.elapsedMs, sig.crossCount);
              return (
                <>
                  <span
                    className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/60 flex items-center gap-0.5"
                    title={`${level}을(를) 뚫은 뒤 한 번도 내려오지 않고 ${info.elapsedLabel}째 유지 중입니다(아직 눌림 후 재돌파 이력은 없음)${sig.volSurge ? ' - 거래량 속도도 여전히 높습니다' : ''} - 오늘 ${level} 돌파 시도 ${sig.crossCount}번째`}
                  >
                    <Target className="w-2.5 h-2.5" />
                    {level} 돌파유지({info.elapsedLabel}){sig.volSurge ? '·거래량↑' : ''}
                  </span>
                  {crossLabelSpan}
                </>
              );
            }
            if (sig.reclaimed && sig.elapsedMs != null) {
              const info = computeReclaimFreshnessInfo(sig.elapsedMs, sig.crossCount);
              if (info.tier === 'justConfirmed') {
                return (
                  <>
                    <span
                      className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-purple-50/60 dark:bg-purple-950/30 text-purple-400 dark:text-purple-500 border-purple-100 dark:border-purple-900/60 flex items-center gap-0.5"
                      title={`방금(${info.elapsedLabel} 전) ${level}을(를) 재돌파했습니다 - 아직 힘을 확인하는 중입니다(신뢰도 낮음) - 오늘 ${level} 돌파 시도 ${sig.crossCount}번째`}
                    >
                      <Target className="w-2.5 h-2.5" />
                      {level} 재돌파 확인
                    </span>
                    {crossLabelSpan}
                  </>
                );
              }
              const staleClass = info.tier === 'established'
                ? 'bg-slate-50 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700/60'
                : 'bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/60';
              return (
                <>
                  <span
                    className={`text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border flex items-center gap-0.5 ${staleClass}`}
                    title={`${info.elapsedLabel} 전 ${level}을(를) 재돌파해 계속 유지 중입니다${sig.volSurge ? ' - 거래량 속도도 여전히 높습니다' : ''}(참고용) - 오늘 ${level} 돌파 시도 ${sig.crossCount}번째`}
                  >
                    <Target className="w-2.5 h-2.5" />
                    {level} 완료({info.elapsedLabel}){sig.volSurge ? '·거래량↑' : ''}
                  </span>
                  {crossLabelSpan}
                </>
              );
            }
            // 🎯 [기능 재설계 - 사용자 요청: "박스구간 뚫고 내려오면 돌파후하락", 데스크톱과 동일(수칙 1-6)]
            if (sig.hadPriorBreak) {
              return (
                <span
                  className="text-[9px] px-1 py-0.2 rounded font-bold shrink-0 border bg-slate-50 dark:bg-slate-900/60 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700/60 flex items-center gap-0.5 opacity-70"
                  title={`오늘 ${level}을(를) 뚫었다가(박스권에 갇혀 있었을 수도 있음) 다시 아래로 내려갔습니다(현재는 재접근 신호 없음, 대기 중)`}
                >
                  <Target className="w-2.5 h-2.5" />
                  {level} 돌파후하락
                </span>
              );
            }
            return null;
          })()}
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
          {activeTab === 'overlap'
            ? buildOverlapSubLine(item, overlapMode, quietAccumFilter)
            : activeTab === 'discovery'
            ? (item.absorptionBadge || '데이터 없음')
            : activeTab === 'precursor'
            ? `종가/고가 ${item.closeToHighRatioPct != null ? item.closeToHighRatioPct.toFixed(2) : '-'}% · 외국인 가집계 ${item.foreignRatioEstimate != null ? item.foreignRatioEstimate.toFixed(1) + '%' : '-'}${item.foreignRatioEstimateRankPct != null ? ` (상위${item.foreignRatioEstimateRankPct.toFixed(0)}%)` : ''}`
            : activeTab === 'surging' || activeTab === 'postmarket'
            ? (item.surgingBadge || `거래량 ${item.volume?.toLocaleString() || '-'}`)
            : activeTab === 'comprehensive'
            ? `종합점수 ${item.scoreBreakdown?.totalScore ?? '-'}점`
            : activeTab === 'watchlist'
            ? `거래량 ${item.volume?.toLocaleString() || '-'}`
            : `순매수 ${formatEok(item.netBuyAmtEok)}`}
        </div>
      </div>
      <div className="text-right shrink-0 flex items-center gap-1.5">
        <div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white">{item.currentPrice?.toLocaleString()}</div>
          <div className={`text-[11px] font-mono font-semibold ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
            {isUp ? '+' : ''}{item.changeRate?.toFixed(2)}%
          </div>
          {/* 🚨 [UI 수정] 급등주 탭 거래대금을 작은 회색 서브라인에 끼워 넣었더니 사용자가 "매매 판단에
              써야 하는 값인데 안 보인다"고 지적했다 - 현재가/등락률과 동일하게 오른쪽 상단 눈에 띄는
              자리에 굵게 세 번째 줄로 노출한다(데스크톱 1827~1830번 줄의 "거래대금 (억원) - 빨간색
              포맷팅" 강조 방식과 동일 취지). */}
          {(activeTab === 'surging' || activeTab === 'postmarket') && (
            <div className="text-[11px] font-mono font-bold text-amber-600 dark:text-amber-400">
              {(item.amountEok || 0).toLocaleString()}억
            </div>
          )}
          {activeTab === 'discovery' && (
            <div className="text-[11px] font-mono font-bold text-amber-600 dark:text-amber-400">
              점수 {item.discoveryScore != null ? item.discoveryScore.toFixed(1) : '-'}
            </div>
          )}
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
  const [overlapMode, setOverlapMode] = useState<OverlapMode>('daily');
  // 🚨 [기능 재설계 - 사용자 요청: "토글 필터로 진행해줘"] 데스크톱과 동일하게, 예전엔 3일연속 전용
  // 4번째 버튼("수급 장마감 후보군")이었던 걸 당일/2일연속/3일연속 어디서나 켤 수 있는 독립 토글로 분리.
  const [quietAccumFilter, setQuietAccumFilter] = useState(false);
  const [market, setMarket] = useState<MarketType>('ALL');
  const queryClient = useQueryClient();

  // 🚨 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "당연하지 모바일도 데스크탑이랑 볼수있는
  // 탭과 차트는 같아야지"] 관심종목 탭만 있고 종목을 추가/제거할 방법이 없으면 못 채운다 - 데스크톱의
  // 종목명 옆 별(⭐) 토글을 그대로 이식한다(InvestorRankingTable.tsx 125~158번 줄과 동일 queryKey
  // 'ws-watchlist'를 써서 두 화면이 별도 호출 없이 캐시를 공유한다).
  const { data: wsWatchlistData } = useQuery<{ symbols: Array<{ symbol: string }> }>({
    queryKey: ['ws-watchlist'],
    queryFn: async () => {
      const res = await fetch('/api/ws-watchlist');
      if (!res.ok) throw new Error('관심종목 목록 조회 실패');
      return res.json();
    },
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
  const wsWatchlistSet = new Set((wsWatchlistData?.symbols || []).map((s) => s.symbol));
  const [wsWatchlistTogglingSymbol, setWsWatchlistTogglingSymbol] = useState<string | null>(null);

  const toggleWsWatchlistSymbol = async (symbol: string, name: string) => {
    setWsWatchlistTogglingSymbol(symbol);
    try {
      if (wsWatchlistSet.has(symbol)) {
        await fetch(`/api/ws-watchlist?symbol=${symbol}`, { method: 'DELETE' });
      } else {
        await fetch('/api/ws-watchlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbol, name }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['ws-watchlist'] });
      await queryClient.invalidateQueries({ queryKey: ['m-surging', 'watchlist'] });
    } finally {
      setWsWatchlistTogglingSymbol(null);
    }
  };

  const [creditOnly, setCreditOnly] = useState(false);
  const [entryReadyOnly, setEntryReadyOnly] = useState(false);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [showWeightPanel, setShowWeightPanel] = useState(false);
  const [showDropouts, setShowDropouts] = useState(false);
  const [dropoutScope, setDropoutScope] = useState<'today' | 'yesterday'>('today');
  // 카드를 탭하면 그 카드 바로 아래에 상세를 펼친다(데스크톱 InvestorRankingTable.tsx의 expandedSymbols
  // 아코디언과 동일하게 한 번에 1개만 펼침).
  const [expandedSymbol, setExpandedSymbol] = useState<string>('');
  // 🎯 [재설계 - 데스크톱과 동일, 수칙 1-6] 실시간 감시 토글 - 켜면 화면에 뜬 후보 전체를 15초 주기로
  // 계속 갱신한다(종목당 1콜짜리 가벼운 방식).
  const [vwapWatchEnabled, setVwapWatchEnabled] = useState(false);
  // 🎯 [기능 추가 - 데스크톱과 동일] R1/R2 재돌파 감시 - VWAP와 별개 토글, 둘 다 켜면 같이 보임.
  const [pivotWatchEnabled, setPivotWatchEnabled] = useState(false);
  // 🎯 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 요청: "토글들 계속 껏다켰다 하기 너무 힘든데",
  // "급등주 다른 토글은 실시간 감시 되는데 급등주 교집합은 안되잖냐.. 다 되게 해줘야지"] VWAP·피봇
  // 감시를 하나의 버튼으로 합친다. 급등주 교집합을 포함한 모든 서브모드에 동일하게 적용된다.
  const handleRealtimeWatchToggle = () => {
    const turningOn = !vwapWatchEnabled;
    setVwapWatchEnabled(turningOn);
    setPivotWatchEnabled(turningOn);
  };

  // 🚨 [기능 추가 - "모바일에는 장마감 후보군 안뜨던데"] 데스크톱 InvestorRankingTable.tsx 84번 줄과 동일 -
  // postmarket도 surgingMode 서브탭과 무관하게 항상 고정된 모드(postmarket)로 fetchSurging을 재사용한다.
  // discovery/precursor도 순매수 개념이 없는 "장마감 후보군" 그룹이라 포함한다.
  // 🚨 [기능 추가 - 데스크톱과 동일(수칙 1-6)] watchlist도 순매수 개념이 없는 그룹이라 포함한다.
  const isSurging = activeTab === 'surging' || activeTab === 'comprehensive' || activeTab === 'postmarket' || activeTab === 'discovery' || activeTab === 'precursor' || activeTab === 'watchlist';
  const isComprehensive = activeTab === 'comprehensive';
  // 🚨 [기능 통합 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로"] 데스크톱과
  // 동일 - 화면엔 "장마감 후보군" 탭 하나만 보이고 activeTab 자체는 셋 중 하나를 유지한다.
  const isPostMarketGroup = activeTab === 'postmarket' || activeTab === 'discovery' || activeTab === 'precursor';

  const surgingQueryMode = activeTab === 'comprehensive' ? 'comprehensive' : activeTab === 'postmarket' ? 'postmarket' : activeTab === 'watchlist' ? 'watchlist' : surgingMode;

  const { data, isLoading, isError } = useQuery<InvestorRankingResponse>({
    queryKey: activeTab === 'discovery'
      ? ['m-discovery', market]
      : activeTab === 'precursor'
      ? ['m-precursor', market]
      : isSurging
      ? ['m-surging', surgingQueryMode, market]
      : ['m-ranking', activeTab, direction, period, overlapMode, market, quietAccumFilter],
    queryFn: async () => {
      // 🚨 [기능 추가 - "발굴 장마감" 탭] cron이 미리 계산해둔 오늘자 스냅샷만 읽는다(데스크톱과 동일).
      if (activeTab === 'discovery') {
        const res = await fetch(`/api/stock/discovery?market=${market}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '발굴 장마감 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      // 🚨 [기능 추가 - "전조 장마감" 탭] 발굴 장마감과 동일 패턴.
      if (activeTab === 'precursor') {
        const res = await fetch(`/api/stock/precursor?market=${market}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '전조 장마감 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      // 🚨 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 요청: "관심종목으로 누른 종목들 관심종목으로
      // 따로 빼줘"] 관심종목(ws_watchlist) 실시간 현재가 - market 필터 없이 등록된 전체를 반환한다.
      if (activeTab === 'watchlist') {
        const res = await fetch('/api/stock/watchlist-ranking');
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '관심종목 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      return isSurging
        ? fetchSurging(surgingQueryMode, market)
        : fetchRanking(activeTab, direction, period, overlapMode, market, activeTab === 'overlap' && quietAccumFilter);
    },
    staleTime: 30 * 1000,
    // 🚨 [버그 수정] 프로그램 탭이 콜드스타트 직후(더미 시그니처가 섞인 stillWarming:true 상태)일 때
    // 데스크톱(InvestorRankingTable.tsx:121)은 50초마다 자동 재조회해서 예열이 끝나는 대로 화면이
    // 저절로 채워지는데, 모바일엔 이 폴링이 없어 그 상태로 영원히 멈춰 있었다(새로고침해야만 나아짐) -
    // 사용자 지적("다른 탭들이 안떠")의 실제 원인.
    refetchInterval: (query) => {
      const d = query.state.data as InvestorRankingResponse | undefined;
      if (d?.isPartial) return 4 * 1000;
      if (activeTab === 'program' && d?.stillWarming) return 50 * 1000;
      // 🚨 [기능 재설계 - 데스크톱과 동일(수칙 1-6)] 아래 realtime_quotes 구독(useEffect)이 진짜 push를
      // 담당하고, 이 30초는 연결 끊김/재시작/41개 초과분 대비 안전망으로만 남긴다.
      if (activeTab === 'watchlist') return 30 * 1000;
      return false;
    },
  });

  // 🎯 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 요청: "관심종목 웹소캣으로 실시간 된다는거
  // 아니였어? 안되는데" - "당연하지 모바일도 데스크탑이랑 같아야지"] Supabase Realtime으로
  // realtime_quotes 테이블 변경을 직접 구독한다 - 오라클 클라우드의 ws-bridge가 KIS 웹소켓 틱마다
  // 이 표에 upsert하면 Postgres 변경 스트림이 새 웹소켓 서버 없이 브라우저로 바로 push된다.
  useEffect(() => {
    if (activeTab !== 'watchlist') return;
    const client = getSupabaseBrowserClient();
    if (!client) return;

    const queryKey = ['m-surging', 'watchlist', market];
    const channel = client
      .channel('m-watchlist-realtime-quotes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'realtime_quotes' },
        (payload) => {
          const row = payload.new as { symbol?: string; price?: number; change?: number; change_rate?: number; volume?: number } | null;
          if (!row?.symbol) return;
          queryClient.setQueryData(queryKey, (old: InvestorRankingResponse | undefined) => {
            if (!old?.list) return old;
            let changed = false;
            const list = old.list.map((item) => {
              if (item.symbol !== row.symbol) return item;
              changed = true;
              return {
                ...item,
                currentPrice: row.price ?? item.currentPrice,
                change: row.change ?? item.change,
                changeRate: row.change_rate ?? item.changeRate,
                volume: row.volume ?? item.volume,
              };
            });
            if (!changed) return old;
            return { ...old, list };
          });
        }
      )
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, [activeTab, market, queryClient]);

  // 🎯 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 요청: "장마감 후보들은 언제 업데이트 되는거야? 각자
  // 토글 옆에 표시해줘"] 발굴/전조는 lastBatchTime을 이미 갖고 있다(수칙 1-5 기준일 표기 관례) - 지금
  // 보고 있는 서브탭이 아니어도 토글 옆에 바로 뜨도록 메인 쿼리와 동일한 키로 항상 캐시해둔다(KIS 호출
  // 없는 Supabase 스냅샷 읽기라 가볍다). "급등"(postmarket)은 KIS 라이브 호출이라 미리 안 당겨온다 -
  // 실제로 눌러서 조회된 뒤에만 라벨이 뜬다.
  const { data: discoveryBatchData } = useQuery<InvestorRankingResponse>({
    queryKey: ['m-discovery', market],
    queryFn: async () => {
      const res = await fetch(`/api/stock/discovery?market=${market}`);
      if (!res.ok) throw new Error('발굴 장마감 데이터를 가져오는 중 오류가 발생했습니다.');
      return res.json();
    },
    enabled: isPostMarketGroup,
    staleTime: 30 * 1000,
  });
  const { data: precursorBatchData } = useQuery<InvestorRankingResponse>({
    queryKey: ['m-precursor', market],
    queryFn: async () => {
      const res = await fetch(`/api/stock/precursor?market=${market}`);
      if (!res.ok) throw new Error('전조 장마감 데이터를 가져오는 중 오류가 발생했습니다.');
      return res.json();
    },
    enabled: isPostMarketGroup,
    staleTime: 30 * 1000,
  });
  const postmarketBatchData = activeTab === 'postmarket' ? data : (queryClient.getQueryData(['m-surging', 'postmarket', market]) as InvestorRankingResponse | undefined);
  const formatBatchLabel = (res: InvestorRankingResponse | undefined): string | null => {
    if (!res) return null;
    if (res.lastBatchTime) return res.lastBatchTime;
    if (res.updatedAt) {
      const kst = new Date(new Date(res.updatedAt).getTime() + 9 * 60 * 60000);
      const hh = String(kst.getUTCHours()).padStart(2, '0');
      const mm = String(kst.getUTCMinutes()).padStart(2, '0');
      return `${hh}:${mm} 기준`;
    }
    return null;
  };

  // 🎯 [재설계 - 데스크톱과 동일] queryKey에 탭/서브모드/시장이 들어있어 탭이 바뀌면 감시 대상도 자동
  // 전환된다(수동 리셋/토큰 관리 불필요).
  // 🚨 [버그 수정 - 사용자 지적: "영원히 로딩중인데?" 데스크톱(InvestorRankingTable.tsx)과 동일 원인
  // (수칙 1-6) - data?.list 순서가 서버리스 인스턴스마다 미세하게 달라 요청마다 흔들릴 수 있는데,
  // 정렬 안 된 join(',')을 그대로 queryKey에 쓰면 순서만 바뀌어도 새 쿼리로 오인해 무한 재요청된다.
  const vwapWatchSymbols = (data?.list || []).map((item) => item.symbol).filter(Boolean);
  const vwapWatchSymbolsKey = [...vwapWatchSymbols].sort().join(',');
  // 🎯 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] 데스크톱과 동일 - VWAP watch와 Pivot watch를
  // 하나의 쿼리로 합쳤다. 예전엔 서로 다른 API 라우트(별도 서버리스 함수)를 때려서 같은 종목 현재가를
  // KIS에 중복으로 물어봤는데, 하나로 합치면 그 중복이 구조적으로 사라진다(수칙 1-6).
  const reclaimWatchEnabled = vwapWatchEnabled || pivotWatchEnabled;
  const { data: reclaimWatchMap, isFetching: reclaimWatchFetching } = useQuery<Map<string, ReclaimWatchSignal>>({
    queryKey: ['m-reclaim-watch', activeTab, surgingMode, market, direction, period, overlapMode, quietAccumFilter, vwapWatchSymbolsKey],
    queryFn: () => fetchReclaimWatchSignals(vwapWatchSymbols),
    enabled: reclaimWatchEnabled && vwapWatchSymbols.length > 0,
    refetchInterval: reclaimWatchEnabled ? 15 * 1000 : false,
    staleTime: 0,
  });
  const vwapReclaimMap = useMemo(() => {
    if (!reclaimWatchMap) return undefined;
    const m = new Map<string, VwapReclaimSignal>();
    reclaimWatchMap.forEach((v, k) => m.set(k, v.vwap));
    return m;
  }, [reclaimWatchMap]);
  const pivotReclaimMap = useMemo(() => {
    if (!reclaimWatchMap) return undefined;
    const m = new Map<string, PivotReclaimSignal>();
    reclaimWatchMap.forEach((v, k) => m.set(k, v.pivot));
    return m;
  }, [reclaimWatchMap]);
  const vwapWatchFetching = reclaimWatchFetching;
  const pivotWatchFetching = reclaimWatchFetching;

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
  }, [activeTab, surgingMode, market, direction, period, overlapMode, quietAccumFilter]);

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
  // 🎯 [기능 추가 - 사용자 요청: "원래 몇위였는지 보여줘"] 데스크톱과 동일 - 켜져 있으면 신호가 뜬
  // 종목만 남기고, 필터링 전 순위를 vwapOriginalRank에 스냅샷으로 남긴 뒤 순위를 재정렬한다.
  // 🚨 [버그 수정 - 실측: 성호전자가 reclaimed:true인데도 화면에서 사라짐] 데스크톱과 동일(수칙 1-6) -
  // 노출 기준은 reclaimed 자체로 하고, volSurge는 배지 부가 정보로만 표시한다.
  // 🚨 [버그 수정 - 데스크톱과 동일] react-query는 enabled가 false여도 마지막 데이터를 들고 있으므로,
  // vwapWatchEnabled가 켜져 있을 때만 필터를 적용한다 - 안 그러면 꺼도 원래 목록으로 안 돌아온다.
  // 🎯 [기능 추가 - 데스크톱과 동일] VWAP·피봇 감시를 둘 다 켜면 OR로 합쳐서 보여준다.
  // 🚨 [버그 수정 - 코드 리뷰 발견: 다른 탭으로 이동해도 필터가 안 꺼짐] 데스크톱과 동일한 문제
  // (InvestorRankingTable.tsx) - 토글 버튼은 (activeTab === 'surging' || activeTab === 'overlap') &&
  // !showDropouts일 때만 렌더링되는데, 이 필터는 activeTab과 무관하게 적용되고 있었다.
  // 🚨 [기능 추가 - 사용자 요청: "장마감 후보군 탭에도 VWAP 실시간 감시, 피봇 재돌파 감시 넣어줘"]
  const watchTogglesVisible = (activeTab === 'surging' || activeTab === 'overlap' || isPostMarketGroup) && !showDropouts;
  // 🚨 [버그 수정 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "급등주 다른 토글은 실시간 감시 되는데
  // 급등주 교집합은 안되잖냐.. 다 되게 해줘야지"] 급등주 교집합도 다른 서브모드와 동일하게 감시 대상이다.
  const vwapWatchActive = watchTogglesVisible && vwapWatchEnabled && !!vwapReclaimMap;
  const pivotWatchActive = watchTogglesVisible && pivotWatchEnabled && !!pivotReclaimMap;
  // 🎯 [기능 재설계 - 사용자 요청: "재돌파 임박 → 재돌파 확인 → 돌파 완료 → 완료 후 5분 경과 순으로
  // 정렬"] 데스크톱(InvestorRankingTable.tsx)의 getWatchPriority와 동일한 신선도 기반 우선순위(수칙
  // 1-6) - 예전엔 필터만 하고 정렬은 안 해서 화면 순서가 신선도와 무관했다.
  // 🚨 [기능 재설계 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "번개로고가 vwap인거 아니야? 그게 나오지
  // 말고 피봇에 녹아들어서 점수를 내야하는거라고" - "R1/R2 = 주된 돌파 레벨, VWAP = 보조 지표"] 정렬
  // 우선순위는 R1/R2만으로 정하고, VWAP는 완전히 동점일 때만 순서를 살짝 미는 타이브레이커로만 쓴다.
  const getMobileWatchPriority = (item: RankingItem): { priority: number; elapsedMs: number; vwapBonus: boolean } => {
    const p = pivotWatchActive ? pivotReclaimMap!.get(item.symbol) : undefined;
    // 🚨 [버그 수정 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"]
    const pLevel = p && (p.r2.approaching || p.r2.reclaimed || p.r2.holding || p.r2.hadPriorBreak) ? p.r2 : p?.r1;
    let pPriority = 0;
    let pElapsed = 0;
    if (pLevel?.approaching) {
      pPriority = 5;
    } else if ((pLevel?.reclaimed || pLevel?.holding) && pLevel.elapsedMs != null) {
      // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?", 데스크톱과 동일(수칙 1-6)]
      const info = computeReclaimFreshnessInfo(pLevel.elapsedMs, pLevel.crossCount);
      pPriority = info.priority;
      pElapsed = pLevel.elapsedMs;
    } else if (pLevel?.hadPriorBreak) {
      pPriority = 1;
    }

    // 🚨 [재설계 - 데스크톱과 동일(수칙 1-6), 사용자 지적: "박스권 하락, 박스권 돌파 이런걸
    // 원했던건데... 순위표 배지로"] R1/R2와 무관한 순수 가격 흐름 신호(priceLeg)도 정렬에 반영.
    const priceLegPriority = p?.priceLeg?.type === 'up' ? 4 : p?.priceLeg?.type === 'down' ? 3 : p?.priceLeg?.type === 'box' ? 2 : 0;
    pPriority = Math.max(pPriority, priceLegPriority);

    const v = vwapWatchActive ? vwapReclaimMap!.get(item.symbol) : undefined;
    const vwapBonus = !!(v?.reclaimed || v?.approaching); // "VWAP도 같이 회복 중" - 가산점(동점 타이브레이커)만.

    return { priority: pPriority, elapsedMs: pElapsed, vwapBonus };
  };
  if (pivotWatchActive) {
    list = list
      .map((item) => ({ item, ...getMobileWatchPriority(item) }))
      .filter(({ priority }) => priority > 0)
      .sort((a, b) => b.priority - a.priority || (Number(b.vwapBonus) - Number(a.vwapBonus)) || a.elapsedMs - b.elapsedMs || a.item.rank - b.item.rank)
      .map(({ item }, idx) => ({ ...item, vwapOriginalRank: item.rank, rank: idx + 1 }));
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* 6개 탭 */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          // "장마감 후보군" 탭 버튼은 activeTab이 postmarket/discovery/precursor 중 무엇이든 활성 표시.
          const isActive = t.id === 'postmarket' ? isPostMarketGroup : activeTab === t.id;
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
          {/* 🎯 [기능 추가 - 데스크톱과 동일(수칙 1-6), 사용자 요청: "급등주 다른 토글은 실시간 감시
              되는데 급등주 교집합은 안되잖냐.. 다 되게 해줘야지"] 급등주 교집합 바로 옆에 둔다 - 급등주
              교집합을 포함한 모든 서브모드에 동일하게 적용된다. */}
          <button
            onClick={handleRealtimeWatchToggle}
            title="켜면 VWAP 재돌파·피봇(R1·R2) 재돌파를 15초 주기로 함께 실시간 감시합니다(지금 보고 있는 서브모드 전체에 적용)"
            className={`flex items-center gap-1 shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
              vwapWatchEnabled
                ? 'bg-gradient-to-r from-sky-600 to-violet-600 text-white border-transparent'
                : 'bg-white dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'
            }`}
          >
            <Zap className="w-3 h-3" />
            실시간 감시
            {vwapWatchEnabled && (vwapWatchFetching || pivotWatchFetching) && <RefreshCw className="w-3 h-3 animate-spin" />}
          </button>
        </div>
      )}

      {/* 🚨 [기능 통합 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로"] 급등/발굴/전조 서브탭 */}
      {isPostMarketGroup && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
            {([
              { id: 'postmarket' as const, label: '급등', icon: Target, batch: postmarketBatchData },
              { id: 'discovery' as const, label: '발굴', icon: Compass, batch: discoveryBatchData },
              { id: 'precursor' as const, label: '눌림후속', icon: Radar, batch: precursorBatchData },
            ]).map((m) => {
              const Icon = m.icon;
              const isActive = activeTab === m.id;
              const batchLabel = formatBatchLabel(m.batch);
              return (
                <button
                  key={m.id}
                  onClick={() => setActiveTab(m.id)}
                  className={`flex items-center gap-1 shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                    isActive
                      ? 'bg-amber-600 text-white border-transparent'
                      : 'bg-white dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39]'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {m.label}
                  {/* 🎯 [기능 추가 - 사용자 요청: "마지막 업데이트 시점이 언제인지 알려줘야 안헷갈릴거
                      같아 - 각자 토글 옆에"] */}
                  {batchLabel && <span className="opacity-70 font-normal">{batchLabel}</span>}
                </button>
              );
            })}
          </div>
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
        {/* 🚨 [기능 재설계 - 사용자 요청: "토글 필터로 진행해줘"] 당일/2일연속/3일연속 어디서나 켤 수 있는
            "장마감 후보만" 토글 - 데스크톱 InvestorRankingTable.tsx와 동일 위치(진입가능만 옆)·동일 문구. */}
        {activeTab === 'overlap' && !showDropouts && (
          <button
            onClick={() => setQuietAccumFilter((v) => !v)}
            title="지금 보고 있는 교집합 명단을, 저가마감·조용한 거래량·최근 눌림 기준으로 재정렬한 상위 후보만 추려서 봅니다 (실측 백테스트 검증)"
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border transition ${
              quietAccumFilter ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white border-transparent' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39]'
            }`}
          >
            <Target className="w-3 h-3" />
            장마감 후보만
          </button>
        )}
        {/* 🎯 [재설계 - 데스크톱과 동일(수칙 1-6)] 실시간 감시 토글 - VWAP·피봇 감시를 하나로 합쳤다
            (사용자 요청: "토글들 계속 껏다켰다 하기 너무 힘든데"). 급등주 탭에서는 이 버튼 대신 서브탭
            줄(급등주 교집합 옆)에 이미 있으므로 여기서는 중복 표시하지 않는다. */}
        {(activeTab === 'overlap' || isPostMarketGroup) && !showDropouts && (
          <button
            onClick={handleRealtimeWatchToggle}
            title="켜면 VWAP 재돌파·피봇(R1·R2) 재돌파를 15초 주기로 함께 실시간 감시합니다"
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border transition ${
              vwapWatchEnabled ? 'bg-gradient-to-r from-sky-600 to-violet-600 text-white border-transparent' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39]'
            }`}
          >
            <Zap className="w-3 h-3" />
            {vwapWatchEnabled ? '실시간 감시 중' : '실시간 감시'}
            {/* 🚨 [버그 수정 - 사용자 지적: "감시중인거 로딩중이면 로딩인거 알수있게 옆에 둔 도형이라도
                활용해봐"] 데스크톱과 동일 - 아이콘 pulse만으론 15초 주기 재조회 순간이 잘 안 보여서,
                isFetching일 때만 옆에 작은 회전 아이콘을 별도로 띄운다(수칙 1-6). */}
            {vwapWatchEnabled && (vwapWatchFetching || pivotWatchFetching) && <RefreshCw className="w-3 h-3 animate-spin" />}
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
        <MobileLoadingSpinner label="불러오는 중..." />
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
                  quietAccumFilter={quietAccumFilter}
                  pivotSignal={pivotWatchEnabled ? pivotReclaimMap?.get(item.symbol) : undefined}
                  pivotWatchActive={pivotWatchActive}
                  isExpanded={isExpanded}
                  onClick={() => setExpandedSymbol((prev) => (prev === item.symbol ? '' : item.symbol))}
                  isWsWatchlisted={wsWatchlistSet.has(item.symbol)}
                  wsWatchlistToggling={wsWatchlistTogglingSymbol === item.symbol}
                  onToggleWsWatchlist={() => toggleWsWatchlistSymbol(item.symbol, item.name)}
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
