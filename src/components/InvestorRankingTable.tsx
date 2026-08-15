'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  InvestorRankingResponse,
  InvestorTrendResponse,
  MarketType,
  RankingDirection,
  RankingItem,
  RankingPeriod,
  RankingType,
  SurgingMode,
} from '@/lib/types';
import { getStockName, registerRuntimeStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, TOP_50_STOCKS, resolveMarketType } from '@/lib/mockData';
import RankingStockDetailChart from './RankingStockDetailChart';
import {
  Globe2,
  Landmark,
  Coins,
  Cpu,
  Flame,
  ArrowUpDown,
  Clock,
  Info,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Zap,
  Rocket,
  Filter,
  CheckCircle2,
  Trophy,
  ChevronDown,
  ChevronUp,
  Activity,
} from 'lucide-react';

interface InvestorRankingTableProps {
  selectedSymbol?: string;
  chartData?: InvestorTrendResponse;
  onSelectSymbol?: (symbol: string, item?: RankingItem) => void;
}

async function fetchRanking(
  type: RankingType,
  direction: RankingDirection,
  period: RankingPeriod,
  mode: 'daily' | 'consecutive3d' = 'daily',
  limit: number = 20,
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  const res = await fetch(
    `/api/stock/ranking?type=${type}&direction=${direction}&period=${period}&mode=${mode}&limit=${limit}&market=${market}`
  );
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '매매 순위 데이터를 가져오는 중 오류가 발생했습니다.');
  }
  return res.json();
}

function getIntradaySnapshotNoticeText(hasRealData: boolean): string {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeNum = hours * 100 + minutes;

  if (!hasRealData) {
    let targetTimeStr = '09:30';
    if (timeNum >= 930 && timeNum < 1120) targetTimeStr = '11:20';
    else if (timeNum >= 1120 && timeNum < 1320) targetTimeStr = '13:20';
    else if (timeNum >= 1320 && timeNum < 1430) targetTimeStr = '14:30';

    return `⏳ 한투 API 장중가집계 스냅샷 갱신 대기 중 (09:30, 11:20, 13:20, 14:30 고시. KIS 서버 반영 지연 시 5~10분 소요될 수 있습니다. / 다음 예정: ${targetTimeStr})`;
  }

  if (timeNum < 930) {
    return 'ℹ️ 장중가집계 스냅샷 1차 반영 완료 (다음 갱신 예정: 오전 11시 20분)';
  } else if (timeNum < 1120) {
    return 'ℹ️ 장중가집계 스냅샷 1차(09:30) 반영 완료 (다음 갱신 예정: 오전 11시 20분)';
  } else if (timeNum < 1320) {
    return 'ℹ️ 장중가집계 스냅샷 2차(11:20) 반영 완료 (다음 갱신 예정: 오후 1시 20분)';
  } else if (timeNum < 1430) {
    return 'ℹ️ 장중가집계 스냅샷 3차(13:20) 반영 완료 (다음 갱신 예정: 오후 2시 30분)';
  } else {
    return 'ℹ️ 장중가집계 4차(14:30) 스냅샷 및 최종 수급 집계 반영 완료';
  }
}

export default function InvestorRankingTable({ selectedSymbol: propSelectedSymbol, chartData, onSelectSymbol }: InvestorRankingTableProps) {
  const [market, setMarket] = useState<MarketType>('ALL');
  const [activeTab, setActiveTab] = useState<RankingType>('surging');
  const [direction, setDirection] = useState<RankingDirection>('buy');
  const [period, setPeriod] = useState<RankingPeriod>('1d');
  const [sortField, setSortField] = useState<keyof RankingItem>('netBuyAmt');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [overlapMode, setOverlapMode] = useState<'daily' | 'consecutive3d'>('daily');
  const [overlapLimit, setOverlapLimit] = useState<number>(20);
  const [creditOnly, setCreditOnly] = useState<boolean>(false);
  const [surgingMode, setSurgingMode] = useState<SurgingMode>('fluctuation');

  // Selected Stock for Right Chart (Single Source of Truth)
  const [internalSymbol, setInternalSymbol] = useState<string>('005930');
  const [selectedRank, setSelectedRank] = useState<number>(1);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const selectedSymbol = propSelectedSymbol || internalSymbol;
  const isSurging = activeTab === 'surging' || activeTab === 'comprehensive';

  const { data, isLoading, isError, refetch, isFetching } = useQuery<InvestorRankingResponse>({
    queryKey: isSurging
      ? ['surging', activeTab === 'comprehensive' ? 'comprehensive' : surgingMode, market]
      : ['ranking', activeTab, direction, period, overlapMode, overlapLimit, market],
    queryFn: async () => {
      if (activeTab === 'comprehensive') {
        const res = await fetch(`/api/stock/surging?mode=comprehensive&market=${market}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '종합랭킹 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      if (isSurging) {
        const res = await fetch(`/api/stock/surging?mode=${surgingMode}&market=${market}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '급등주 순위 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      return fetchRanking(activeTab, direction, period, overlapMode, overlapLimit, market);
    },
    refetchInterval: false,
    placeholderData: (previousData) => previousData,
  });

  const queryClient = useQueryClient();
  const hasInitializedRef = useRef<boolean>(false);

  useEffect(() => {
    if (data?.list && data.list.length > 0) {
      data.list.forEach((item) => {
        if (item.symbol && item.name) {
          registerRuntimeStockName(item.symbol, item.name);
        }
      });

      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        const topItem = data.list[0];
        if (topItem && topItem.symbol) {
          if ((data as any).initialTrend) {
            queryClient.setQueryData(['investorTrend', topItem.symbol, '60d'], (data as any).initialTrend);
          }
          if (!selectedSymbol && onSelectSymbol) {
            onSelectSymbol(topItem.symbol, topItem);
          }
        }
      }
    }
  }, [data?.list, selectedSymbol, onSelectSymbol, queryClient]);

  // Extract unpriced symbols for non-blocking async background quote fetching
  const unpricedSymbolsKey = useMemo(() => {
    if (!data?.list) return '';
    return data.list
      .map((item) => item.symbol)
      .filter((sym) => resolveStockPriceAndChange(sym, 0, 0, 0).currentPrice === 0)
      .join(',');
  }, [data?.list]);

  // Non-blocking async background quotes query
  const { data: quotesData } = useQuery<{ quotes: Record<string, { currentPrice: number; change: number; changeRate: number }> }>({
    queryKey: ['quotes-batch', unpricedSymbolsKey],
    queryFn: async () => {
      if (!unpricedSymbolsKey) return { quotes: {} };
      const requestedSymbolsSet = new Set(unpricedSymbolsKey.split(','));
      const res = await fetch(`/api/stock/quotes?symbols=${unpricedSymbolsKey}`);
      if (!res.ok) return { quotes: {} };
      const json = await res.json();
      if (json.quotes) {
        Object.entries(json.quotes).forEach(([sym, q]: [string, any]) => {
          if (requestedSymbolsSet.has(sym) && q.currentPrice > 0) {
            updateRuntimeStockPrice(sym, q.currentPrice, q.change, q.changeRate);
          }
        });
      }
      return json;
    },
    enabled: Boolean(unpricedSymbolsKey),
    staleTime: 30000,
  });

  const isBuy = direction === 'buy';

  const handleSort = (field: keyof RankingItem) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const handleStockSelect = (e: React.MouseEvent, item: RankingItem) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      const sym = item?.symbol || (item as any)?.code || (item as any)?.stk_cd || (item as any)?.stockCode || '';
      if (!sym) {
        console.warn('[Stock Select] Valid symbol not found for item:', item);
        return;
      }
      const fullItem: RankingItem = {
        ...item,
        type: activeTab,
      };
      setInternalSymbol(sym);
      setSelectedRank(item?.rank || 1);
      // Auto-toggle expand state (ONLY 1 stock expanded at a time across all tabs)
      setExpandedSymbols((prev) => (prev[sym] ? {} : { [sym]: true }));
      if (onSelectSymbol) {
        onSelectSymbol(sym, fullItem);
      }

      // Smooth internal scroll ONLY within tableContainerRef (subtracting sticky header height so clicked stock sits directly under the header)
      setTimeout(() => {
        const targetRow = document.getElementById(`stock-row-${sym}`);
        const container = tableContainerRef.current;
        if (targetRow && container) {
          const thead = container.querySelector('thead');
          const headerHeight = thead ? thead.offsetHeight : 38;
          const targetScrollTop = Math.max(0, targetRow.offsetTop - headerHeight);
          container.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth',
          });
        }
      }, 50);
    } catch (err) {
      console.error('[Stock Select Error]', err);
    }
  };

  // Accordion state for expanded comprehensive 7-indicator breakdown cards
  const [expandedSymbols, setExpandedSymbols] = useState<Record<string, boolean>>({});

  const toggleExpand = (symbol: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedSymbols((prev) => ({ ...prev, [symbol]: !prev[symbol] }));
  };

  // Priority weight preset for Comprehensive Score Ranking (Sum = 100%)
  // Vol: 50%, Amt: 20%, Fluc: 10%, TrendAlign: 5%, CloseStrength: 5%, Foreign: 5%, Organ: 5%
  const DEFAULT_WEIGHTS = {
    volInc: 50,
    amt: 20,
    fluc: 10,
    trendAlign: 5,
    closeStrength: 5,
    foreign: 5,
    organ: 5,
  };

  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  // Sub-mode for Comprehensive Score Ranking: 'balance' (Weighted Average) vs 'singleSignal' (Extreme Single Signal Focus)
  const [comprehensiveMode, setComprehensiveMode] = useState<'balance' | 'singleSignal'>('balance');

  const isComprehensive = activeTab === 'comprehensive' || (activeTab === 'surging' && surgingMode === 'comprehensive');

  // 1. Initial Raw Copy of Candidates
  let fullList: RankingItem[] = data?.list ? data.list.map((item) => ({ ...item })) : [];

  // Guarantee strict market tab isolation (No mix-ups between KOSPI and KOSDAQ)
  if (market !== 'ALL') {
    fullList = fullList.filter(
      (item) => resolveMarketType(item.symbol, item.name, item.market) === market
    );
  }

  // 2. Recalculate dynamic scores based on sliders if in comprehensive mode
  if (isComprehensive) {
    const totalWeightSum =
      weights.fluc +
      weights.amt +
      weights.volInc +
      weights.foreign +
      weights.organ +
      weights.trendAlign +
      weights.closeStrength || 1;

    fullList = fullList.map((item) => {
      if (!item.scoreBreakdown) return item;
      const {
        flucScore,
        amtScore,
        volIncScore,
        foreignScore,
        organScore,
        trendAlignScore = 50,
        closeStrengthScore = 50,
      } = item.scoreBreakdown;

      // Hybrid Non-linear RMS calculation based on active slider weights
      const momSumW = weights.fluc + weights.volInc + weights.amt || 1;
      const confSumW = weights.trendAlign + weights.closeStrength + weights.foreign + weights.organ || 1;

      const momSqSum =
        weights.fluc * Math.pow(flucScore, 2) +
        weights.volInc * Math.pow(volIncScore, 2) +
        weights.amt * Math.pow(amtScore, 2);

      const momRmsScore = Math.sqrt(momSqSum / momSumW);

      const confLinearScore =
        (trendAlignScore * weights.trendAlign +
          closeStrengthScore * weights.closeStrength +
          foreignScore * weights.foreign +
          organScore * weights.organ) /
        confSumW;

      const momWeightRatio = momSumW / totalWeightSum;
      const confWeightRatio = confSumW / totalWeightSum;

      const dynamicTotal = Number((momRmsScore * momWeightRatio + confLinearScore * confWeightRatio).toFixed(1));

      // Single Signal Max Score calculation (Core 3 Momentum Signals ONLY: Fluc, Vol, Amt)
      // Excludes supply & confirmation metrics (foreign, organ, candle strength, trend alignment)
      const signalScores = [
        { key: 'fluc', label: '🔥 등락률 1위', score: flucScore },
        { key: 'volInc', label: '⚡ 거래량 1위', score: volIncScore },
        { key: 'amt', label: '💰 거래대금 1위', score: amtScore },
      ].sort((a, b) => b.score - a.score);

      const topSignal = signalScores[0];
      const maxSignalScore = topSignal.score;

      return {
        ...item,
        maxSignalScore,
        topSignalBadge: `${topSignal.label} (${topSignal.score.toFixed(0)}점)`,
        scoreBreakdown: {
          ...item.scoreBreakdown,
          totalScore: comprehensiveMode === 'singleSignal' ? maxSignalScore : dynamicTotal,
        },
      };
    });
  }

  // 3. Sort the FULL Unfiltered List according to active mode & sort fields
  fullList = [...fullList].sort((a, b) => {
    if (isComprehensive) {
      if (comprehensiveMode === 'singleSignal') {
        const diff = ((b as any).maxSignalScore || 0) - ((a as any).maxSignalScore || 0);
        if (Math.abs(diff) > 0.01) return diff;
        return b.changeRate - a.changeRate;
      }
      return (b.scoreBreakdown?.totalScore || 0) - (a.scoreBreakdown?.totalScore || 0);
    }
    // Default ranking sort when sortField === 'netBuyAmt'
    if (sortField === 'netBuyAmt' && !sortAsc) {
      if (activeTab === 'surging') {
        if (surgingMode === 'fluctuation') {
          return b.changeRate - a.changeRate;
        } else if (surgingMode === 'volume') {
          return b.volume - a.volume;
        } else if (surgingMode === 'amount') {
          return (b.amountEok || 0) - (a.amountEok || 0);
        }
      }
      if (activeTab === 'overlap') {
        const countA = a.overlapCount || 0;
        const countB = b.overlapCount || 0;
        if (countB !== countA) {
          return countB - countA;
        }
      }
      return isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
    }

    const valA = a[sortField] ?? 0;
    const valB = b[sortField] ?? 0;
    if (typeof valA === 'number' && typeof valB === 'number') {
      return sortAsc ? valA - valB : valB - valA;
    }
    return sortAsc
      ? String(valA).localeCompare(String(valB))
      : String(valB).localeCompare(String(valA));
  });

  // 4. Assign overallRank to the FULL Sorted List (Strictly 1, 2, 3, 4, 5...)
  fullList = fullList.map((item, idx) => ({
    ...item,
    rank: idx + 1,
    overallRank: idx + 1,
  }));

  // 5. Apply Credit Availability Filter ON TOP of sorted list with assigned overallRanks
  let displayList: RankingItem[] = fullList;
  if (creditOnly) {
    displayList = displayList
      .filter((item) => item.isCreditAvailable === true)
      .map((item, idx) => ({
        ...item,
        rank: idx + 1, // Re-index sequentially for credit-eligible ranking (1, 2, 3...)
      }));
  }

  const hasRealData = useMemo(() => {
    if (!displayList || displayList.length === 0) return false;
    return displayList.some((item) => (item.netBuyAmt || 0) !== 0 || (item.netBuyQty || 0) !== 0);
  }, [displayList]);

  // Track context key (activeTab, direction, period, overlapMode, overlapLimit, market, creditOnly)
  const contextKey = `${activeTab}-${direction}-${period}-${overlapMode}-${overlapLimit}-${market}-${creditOnly}`;
  const prevContextKey = useRef('');

  useEffect(() => {
    if (isFetching) return;

    if (prevContextKey.current !== contextKey && displayList && displayList.length > 0) {
      prevContextKey.current = contextKey;
      const firstItem = displayList[0];
      setInternalSymbol(firstItem.symbol);
      setSelectedRank(firstItem.rank || 1);
      if (onSelectSymbol) {
        onSelectSymbol(firstItem.symbol, { ...firstItem, type: activeTab });
      }
    }
  }, [contextKey, isFetching, displayList]);

  const handleTabChange = (newTab: RankingType) => {
    if (newTab !== activeTab) {
      setActiveTab(newTab);
      setExpandedSymbols({}); // Reset open accordion stock detail charts
      setCreditOnly(false); // Reset credit filter OFF when switching tabs
      if (newTab !== 'overlap') {
        setOverlapMode('daily');
        setOverlapLimit(20);
      }
    }
  };

  const handleSurgingModeChange = (mode: SurgingMode) => {
    if (mode !== surgingMode) {
      setSurgingMode(mode);
      setExpandedSymbols({}); // Reset open accordion stock detail charts
      setCreditOnly(false); // Reset credit filter OFF when switching surging sub-tabs
    }
  };

  const handleMarketChange = (newMarket: MarketType) => {
    if (newMarket !== market) {
      setMarket(newMarket);
      setExpandedSymbols({});
      setCreditOnly(false);
    }
  };

  const handleDirectionChange = (newDir: RankingDirection) => {
    if (newDir !== direction) {
      setDirection(newDir);
      setExpandedSymbols({});
      setCreditOnly(false);
    }
  };

  const handlePeriodChange = (newPeriod: RankingPeriod) => {
    if (newPeriod !== period) {
      setPeriod(newPeriod);
      setExpandedSymbols({});
      setCreditOnly(false);
    }
  };

  const handleComprehensiveModeChange = (mode: 'balance' | 'singleSignal') => {
    if (mode !== comprehensiveMode) {
      setComprehensiveMode(mode);
      setExpandedSymbols({});
      setCreditOnly(false);
    }
  };

  // Reset expanded accordion charts whenever ANY tab, sub-mode, badge, filter, or sorting condition changes
  useEffect(() => {
    setExpandedSymbols({});
  }, [activeTab, surgingMode, market, direction, period, overlapMode, overlapLimit, comprehensiveMode, creditOnly, sortField, sortAsc]);

  const tabs: { id: RankingType; label: string; icon: any; isRealtime: boolean; badge?: string }[] = [
    { id: 'surging', label: '급등주', icon: Rocket, isRealtime: true, badge: 'LIVE' },
    { id: 'comprehensive', label: '단타 종합랭킹', icon: Trophy, isRealtime: true, badge: 'SCORE' },
    { id: 'foreign', label: '외국인', icon: Globe2, isRealtime: true },
    { id: 'organ', label: '기관', icon: Landmark, isRealtime: true },
    { id: 'pension', label: '연기금', icon: Coins, isRealtime: false },
    { id: 'program', label: '프로그램', icon: Cpu, isRealtime: false },
    { id: 'overlap', label: '수급교집합', icon: Flame, isRealtime: true, badge: 'HOT' },
  ];

  const activeTabLabel = tabs.find((t) => t.id === activeTab)?.label || '순위';

  const getOverlapBadgeStyle = (count: number) => {
    if (count >= 4) {
      return {
        label: '4주체 일치',
        bg: 'bg-gradient-to-r from-purple-600 to-pink-600 text-white font-black shadow-xs',
      };
    }
    if (count === 3) {
      return {
        label: '3주체 강중복',
        bg: 'bg-red-500 text-white font-bold',
      };
    }
    return {
      label: '2주체 중복',
      bg: 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-bold',
    };
  };

  const getInvestorRankBadge = (type: string) => {
    switch (type) {
      case 'foreign':
        return 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/40';
      case 'organ':
        return 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/40';
      case 'pension':
        return 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/40';
      case 'program':
        return 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/40';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Top Section: Full Width Investor Ranking Table */}
      <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-2xl p-5 shadow-sm space-y-4 transition-colors duration-200">
        {/* Card Header & Controls */}
        <div className="space-y-3">
          {/* Header Title & Counter - Aligned in a Single Line */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-[#2a2e39]">
            <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2 whitespace-nowrap shrink-0">
                투자자 유형별 매매 순위
              </h2>
              {activeTab === 'overlap' && (
                <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-gradient-to-r from-purple-600 to-amber-600 text-white flex items-center gap-1 shadow-xs animate-pulse whitespace-nowrap shrink-0">
                  {overlapMode === 'consecutive3d' ? <Rocket className="w-3 h-3 shrink-0" /> : <Zap className="w-3 h-3 shrink-0" />}
                  {overlapMode === 'consecutive3d' ? '3일연속 수급교집합' : '당일 수급교집합'}
                </span>
              )}
              {activeTab === 'surging' && (
                <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-gradient-to-r from-red-600 to-orange-500 text-white flex items-center gap-1 shadow-xs animate-pulse whitespace-nowrap shrink-0">
                  <Zap className="w-3 h-3 shrink-0" />
                  실시간 60초 자동 갱신
                </span>
              )}
              {data?.lastBatchTime && activeTab !== 'overlap' && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 flex items-center gap-1 whitespace-nowrap shrink-0">
                  <Clock className="w-3 h-3 shrink-0" />
                  기준시각: {data.lastBatchTime}
                </span>
              )}
            </div>

            {/* Direction & Market & Refresh Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Market Filter (전체 / 코스피 / 코스닥) */}
              <div className="bg-slate-100 dark:bg-[#1e222d] p-1 rounded-xl flex items-center border border-slate-200/60 dark:border-[#2a2e39] gap-0.5 shrink-0">
                {(['ALL', 'KOSPI', 'KOSDAQ'] as MarketType[]).map((m) => (
                  <button
                    type="button"
                    key={m}
                    onClick={() => handleMarketChange(m)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition cursor-pointer font-bold whitespace-nowrap ${
                      market === m
                        ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-xs'
                        : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {m === 'ALL' ? '전체' : m === 'KOSPI' ? '코스피' : '코스닥'}
                  </button>
                ))}
              </div>

              {/* Credit Filter Toggle (신용가능 - 일별 배치 반영) */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setCreditOnly(!creditOnly)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                    creditOnly
                      ? 'bg-emerald-600 text-white border-transparent shadow-xs font-black'
                      : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <CheckCircle2 className={`w-3.5 h-3.5 ${creditOnly ? 'text-emerald-200' : 'text-emerald-500'}`} />
                  <span>신용가능</span>
                </button>
              </div>

              {/* Direction Toggle (순매수 / 순매도) - 급등주 탭 제외 */}
              {!isSurging && (
                <div className="bg-slate-100 dark:bg-[#1e222d] p-1 rounded-xl flex items-center border border-slate-200/60 dark:border-[#2a2e39]">
                  <button
                    type="button"
                    onClick={() => handleDirectionChange('buy')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer ${
                      isBuy
                        ? 'bg-red-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <TrendingUp className="w-3 h-3 shrink-0" />
                    순매수
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDirectionChange('sell')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer ${
                      !isBuy
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <TrendingDown className="w-3 h-3 shrink-0" />
                    순매도
                  </button>
                </div>
              )}

              {/* Refresh Button */}
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isFetching}
                className="p-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] border border-slate-200 dark:border-[#2a2e39] rounded-xl text-slate-600 dark:text-gray-300 transition cursor-pointer"
                title="새로고침"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Tabs & Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Investor Tabs (Left Side) */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none max-w-full">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                const isOverlapTab = tab.id === 'overlap';
                const isSurgingTab = tab.id === 'surging';
                return (
                  <button
                    type="button"
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap border cursor-pointer shrink-0 ${
                      isActive
                        ? isOverlapTab
                          ? 'bg-gradient-to-r from-purple-600 to-amber-600 text-white border-transparent shadow-md'
                          : isSurgingTab
                          ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white border-transparent shadow-md font-black'
                          : 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 border-transparent shadow-xs'
                        : 'bg-slate-50 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <Icon className={`w-3 h-3 ${isOverlapTab ? 'text-amber-300' : ''}`} />
                    <span>{tab.label}</span>
                    {tab.badge ? (
                      <span className="text-[9px] px-1 py-0.2 rounded font-black bg-amber-400 text-slate-900">
                        {tab.badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* Period Filter (Right Side - Hidden when Surging tab is selected) */}
            {!isSurging && (
              <div className="bg-slate-100 dark:bg-[#1e222d] p-1 rounded-xl flex items-center text-xs font-medium border border-slate-200/60 dark:border-[#2a2e39] shrink-0 gap-0.5">
                {(['1d', '1w', '1m'] as RankingPeriod[]).map((p) => {
                  const isActive = period === p;
                  return (
                    <button
                      type="button"
                      key={p}
                      onClick={() => handlePeriodChange(p)}
                      className={`px-3 py-1 rounded-lg text-xs transition cursor-pointer whitespace-nowrap ${
                        isActive
                          ? 'bg-blue-600 text-white shadow-xs font-black'
                          : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white font-semibold'
                      }`}
                    >
                      {p === '1d' ? '당일' : p === '1w' ? '1주일' : '1개월'}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Dedicated Sub-Controls Bar for Surging Tab */}
          {activeTab === 'surging' && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-red-100 dark:border-red-950/40">
              <div className="bg-red-50 dark:bg-red-950/40 p-1 rounded-xl flex items-center text-xs font-medium border border-red-200 dark:border-red-800/40 max-w-full overflow-hidden gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleSurgingModeChange('fluctuation')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    surgingMode === 'fluctuation'
                      ? 'bg-red-600 text-white shadow-xs'
                      : 'text-red-700 dark:text-red-300 hover:text-red-900'
                  }`}
                >
                  <Rocket className="w-3 h-3 shrink-0" />
                  등락률 상위 (급등 순)
                </button>
                <button
                  type="button"
                  onClick={() => handleSurgingModeChange('volume')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    surgingMode === 'volume'
                      ? 'bg-orange-600 text-white shadow-xs'
                      : 'text-red-700 dark:text-red-300 hover:text-red-900'
                  }`}
                >
                  <TrendingUp className="w-3 h-3 shrink-0" />
                  거래량 상위
                </button>
                <button
                  type="button"
                  onClick={() => handleSurgingModeChange('amount')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    surgingMode === 'amount'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-red-700 dark:text-red-300 hover:text-red-900'
                  }`}
                >
                  <Coins className="w-3 h-3 shrink-0" />
                  거래대금 상위
                </button>
                <button
                  type="button"
                  onClick={() => handleSurgingModeChange('overlap')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    surgingMode === 'overlap'
                      ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs font-black'
                      : 'text-red-700 dark:text-red-300 hover:text-red-900'
                  }`}
                >
                  <Flame className="w-3 h-3 text-amber-300 shrink-0" />
                  급등주 교집합 (3중)
                </button>
              </div>
            </div>
          )}

          {/* Dedicated Interactive Weight Control Panel for Comprehensive Score Ranking */}
          {isComprehensive && (
            <div className="bg-gradient-to-r from-purple-900/10 via-indigo-900/10 to-blue-900/10 dark:from-purple-950/40 dark:via-indigo-950/40 dark:to-blue-950/40 border border-purple-200 dark:border-purple-800/50 rounded-2xl p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-500 shrink-0 animate-bounce" />
                  <span className="text-xs font-bold text-slate-900 dark:text-white">
                    단타 종합랭킹 산출 모드:
                  </span>
                  
                  {/* Comprehensive Mode Selector Toggle */}
                  <div className="inline-flex items-center gap-1 bg-white/80 dark:bg-[#131722]/80 p-0.5 rounded-xl border border-purple-200 dark:border-purple-800/50 shadow-xs">
                    <button
                      type="button"
                      onClick={() => handleComprehensiveModeChange('balance')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1 ${
                        comprehensiveMode === 'balance'
                          ? 'bg-purple-600 text-white shadow-xs font-black'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <span>⚖️ 가중합 밸런스</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleComprehensiveModeChange('singleSignal')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1 ${
                        comprehensiveMode === 'singleSignal'
                          ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs font-black'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <span>🔥 극단적 단일신호 우선</span>
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setWeights(DEFAULT_WEIGHTS);
                    setCreditOnly(false);
                    setExpandedSymbols({});
                  }}
                  className="text-[10px] px-2.5 py-1 rounded-lg bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 hover:bg-purple-200 font-bold transition border border-purple-200 dark:border-purple-800/50 cursor-pointer"
                >
                  초기화
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2.5">
                {/* Fluctuation Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-red-500">등락률</span>
                    <span className="font-mono bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded font-black">{weights.fluc}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.fluc}
                    onChange={(e) => setWeights({ ...weights, fluc: Number(e.target.value) })}
                    className="w-full accent-red-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>

                {/* Transaction Amount Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-amber-500">거래대금</span>
                    <span className="font-mono bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded font-black">{weights.amt}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.amt}
                    onChange={(e) => setWeights({ ...weights, amt: Number(e.target.value) })}
                    className="w-full accent-amber-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>

                {/* Volume Increase Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-orange-500">거래량</span>
                    <span className="font-mono bg-orange-50 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400 px-1.5 py-0.5 rounded font-black">{weights.volInc}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.volInc}
                    onChange={(e) => setWeights({ ...weights, volInc: Number(e.target.value) })}
                    className="w-full accent-orange-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>

                {/* Foreigner Supply Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-blue-500">외국인수급</span>
                    <span className="font-mono bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-black">{weights.foreign}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.foreign}
                    onChange={(e) => setWeights({ ...weights, foreign: Number(e.target.value) })}
                    className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>

                {/* Institution Supply Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-purple-500">기관수급</span>
                    <span className="font-mono bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded font-black">{weights.organ}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.organ}
                    onChange={(e) => setWeights({ ...weights, organ: Number(e.target.value) })}
                    className="w-full accent-purple-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>

                {/* Trend Alignment Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-emerald-500">정배열추세</span>
                    <span className="font-mono bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded font-black">{weights.trendAlign}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.trendAlign}
                    onChange={(e) => setWeights({ ...weights, trendAlign: Number(e.target.value) })}
                    className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>

                {/* Close Strength Weight Slider */}
                <div className="bg-white/90 dark:bg-[#131722]/90 p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] space-y-1.5 shadow-xs">
                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                    <span className="text-rose-500">캔들강도</span>
                    <span className="font-mono bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 px-1.5 py-0.5 rounded font-black">{weights.closeStrength}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={weights.closeStrength}
                    onChange={(e) => setWeights({ ...weights, closeStrength: Number(e.target.value) })}
                    className="w-full accent-rose-500 cursor-pointer h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Dedicated Sub-Controls Bar for Overlap Tab Only (Placed cleanly below main tabs) */}
          {activeTab === 'overlap' && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-purple-100 dark:border-purple-950/40">
              {/* Overlap Mode Toggle (Left) */}
              <div className="bg-purple-50 dark:bg-purple-950/40 p-1 rounded-xl flex items-center text-xs font-medium border border-purple-200 dark:border-purple-800/40 max-w-full overflow-hidden gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setOverlapMode('daily')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    overlapMode === 'daily'
                      ? 'bg-purple-600 text-white shadow-xs'
                      : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                  }`}
                >
                  <Flame className="w-3 h-3 shrink-0" />
                  당일 교집합
                </button>
                <button
                  type="button"
                  onClick={() => setOverlapMode('consecutive3d')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    overlapMode === 'consecutive3d'
                      ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs animate-pulse'
                      : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                  }`}
                >
                  <Rocket className="w-3 h-3 shrink-0" />
                  <span>3일연속 교집합</span>
                </button>
              </div>

              {/* Overlap Top Limit Filter (Right) */}
              <div className="bg-slate-100 dark:bg-[#1e222d] p-1 rounded-xl flex items-center text-xs font-medium border border-slate-200/60 dark:border-[#2a2e39] gap-0.5 shrink-0">
                <span className="text-[10px] text-slate-400 font-bold px-1 shrink-0">탐색범위:</span>
                {([10, 20, 30, 50] as number[]).map((limitVal) => {
                  const isActive = overlapLimit === limitVal;
                  return (
                    <button
                      type="button"
                      key={limitVal}
                      onClick={() => setOverlapLimit(limitVal)}
                      className={`px-2 py-0.5 rounded-lg text-xs transition cursor-pointer font-bold whitespace-nowrap ${
                        isActive
                          ? 'bg-purple-600 text-white shadow-xs font-black'
                          : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white font-semibold'
                      }`}
                    >
                      {limitVal === 50 ? 'Top 50(전체)' : `Top ${limitVal}`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ranking Table Content with Fixed Height & Internal Vertical Scroll */}
          {isError ? (
            <div className="p-6 text-center text-xs text-red-500 bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900">
              랭킹 데이터를 불러오지 못했습니다. 다시 시도해 주세요.
            </div>
          ) : (
            /* Fixed Height Scroll Container */
            <div ref={tableContainerRef} className="overflow-y-auto max-h-[740px] rounded-xl border border-slate-200 dark:border-[#2a2e39] scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-700">
              <table className="w-full text-left border-collapse text-xs">
                {/* Sticky Header */}
                <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29] shadow-xs">
                  <tr className="border-b border-slate-200 dark:border-[#2a2e39] text-slate-500 dark:text-[#787b86] font-semibold bg-slate-100 dark:bg-[#1a1e29]">
                    <th className="p-2.5 text-center min-w-[50px] whitespace-nowrap shrink-0 sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">순위</th>
                    <th className="p-2.5 whitespace-nowrap min-w-[110px] sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">종목명</th>

                    {activeTab === 'overlap' ? (
                      <>
                        <th className="p-2.5 whitespace-nowrap min-w-[110px] sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">
                          중복수급
                        </th>
                        <th className="p-2.5 whitespace-nowrap min-w-[200px] sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">
                          {overlapMode === 'consecutive3d' ? '주체별 수급액' : '주체별 상세 순위'}
                        </th>
                      </>
                    ) : null}

                    {isComprehensive ? (
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">종합점수 (총점)</th>
                        <th className="p-2.5 whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">외국인 수급</th>
                        <th className="p-2.5 whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">기관 수급</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">7개 세부 지표</th>
                      </>
                    ) : activeTab === 'surging' ? (
                      surgingMode === 'overlap' ? (
                        <>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">거래량</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">거래대금</th>
                          <th className="p-2.5 whitespace-nowrap min-w-[180px] sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">급등 상세 순위</th>
                          <th className="p-2.5 whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">외국인 수급</th>
                          <th className="p-2.5 whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">기관 수급</th>
                        </>
                      ) : (
                        <>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">거래량</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">거래대금</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">전일대비 거래량</th>
                        </>
                      )
                    ) : (
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">
                          <button type="button" onClick={() => handleSort('currentPrice')} className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer">
                            현재가
                            <ArrowUpDown className="w-3 h-3 opacity-60 shrink-0" />
                          </button>
                        </th>

                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">
                          <button type="button" onClick={() => handleSort('netBuyQty')} className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer font-semibold text-slate-600 dark:text-slate-400">
                            {isBuy ? '순매수 수량' : '순매도 수량'}
                            <ArrowUpDown className="w-3 h-3 opacity-60 shrink-0" />
                          </button>
                        </th>

                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-10 bg-slate-100 dark:bg-[#1a1e29]">
                          <button type="button" onClick={() => handleSort('netBuyAmt')} className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white font-bold text-slate-700 dark:text-slate-300 cursor-pointer">
                            {activeTab === 'overlap'
                              ? overlapMode === 'consecutive3d'
                                ? isBuy
                                  ? '3일누적 순매수'
                                  : '3일누적 순매도'
                                : isBuy
                                ? '합산 순매수'
                                : '합산 순매도'
                              : isBuy
                              ? '순매수 대금'
                              : '순매도 대금'}
                            <ArrowUpDown className="w-3 h-3 text-slate-400 shrink-0" />
                          </button>
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#2a2e39]/60 font-mono">
                  {isLoading ? (
                    Array.from({ length: 10 }).map((_, idx) => (
                      <tr key={`skeleton-${idx}`} className="animate-pulse h-12">
                        <td className="p-2.5 text-center"><div className="w-5 h-4 mx-auto bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                        <td className="p-2.5"><div className="w-24 h-4 bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                        <td className="p-2.5 text-right"><div className="w-16 h-4 ml-auto bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                        <td className="p-2.5 text-right"><div className="w-12 h-4 ml-auto bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                        <td className="p-2.5 text-right"><div className="w-20 h-4 ml-auto bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                        <td className="p-2.5 text-right"><div className="w-20 h-4 ml-auto bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                        <td className="p-2.5 text-right"><div className="w-20 h-4 ml-auto bg-slate-200 dark:bg-slate-700/60 rounded" /></td>
                      </tr>
                    ))
                  ) : displayList.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="p-8 text-center text-xs text-slate-400 dark:text-slate-500">
                        {activeTab === 'overlap'
                          ? (overlapMode === 'consecutive3d'
                              ? '3일 이상 연속 수급이 2개 이상 주체에서 동시에 진행 중인 종목이 없습니다.'
                              : '조건에 부합하는 수급 교집합 종목 데이터가 없습니다.')
                          : `${activeTabLabel} ${isBuy ? '순매수' : '순매도'}${market !== 'ALL' ? ` (${market === 'KOSPI' ? '코스피' : '코스닥'})` : ''} 조건에 부합하는 종목 데이터가 없습니다.`}
                      </td>
                    </tr>
                  ) : (
                    displayList.map((item) => {
                    const liveQuote = quotesData?.quotes?.[item.symbol];
                    const priceInfo = liveQuote && liveQuote.currentPrice > 0
                      ? {
                          symbol: item.symbol,
                          name: getStockName(item.symbol),
                          market: 'KOSPI',
                          currentPrice: liveQuote.currentPrice,
                          change: liveQuote.change,
                          changeRate: liveQuote.changeRate,
                          volume: 0,
                          isCreditAvailable: true,
                        }
                      : resolveStockPriceAndChange(item.symbol, item.currentPrice, item.change, item.changeRate);
                    const isPriceUp = priceInfo.changeRate > 0;
                    const isPriceDown = priceInfo.changeRate < 0;
                    const badgeStyle = getOverlapBadgeStyle(item.overlapCount || 0);
                    const isSelected = selectedSymbol === item.symbol;

                    return (
                      <React.Fragment key={`row-group-${item.symbol}`}>
                        <tr
                          key={item.symbol}
                          id={`stock-row-${item.symbol}`}
                          className={`transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50/90 dark:bg-[#1e293b] font-bold border-l-4 border-blue-600 shadow-xs'
                            : 'hover:bg-slate-50 dark:hover:bg-[#1e222d]'
                        }`}
                        onClick={(e) => handleStockSelect(e, item)}
                      >
                        {/* 순위 */}
                        <td className="p-2.5 text-center font-bold whitespace-nowrap">
                          <div className="flex flex-row items-center justify-center gap-1 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center justify-center w-5 h-5 rounded-md text-[10px] shrink-0 ${
                                item.rank === 1
                                  ? 'bg-amber-500 text-white font-black shadow-xs'
                                  : item.rank === 2
                                  ? 'bg-slate-400 text-white font-bold'
                                  : item.rank === 3
                                  ? 'bg-amber-700 text-white font-bold'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {item.rank}
                            </span>
                            {creditOnly && (item as any).overallRank && (
                              <span className="text-[9px] text-slate-400 dark:text-slate-500 font-sans font-normal whitespace-nowrap shrink-0">
                                (전체 {(item as any).overallRank}위)
                              </span>
                            )}
                          </div>
                        </td>

                        {/* 종목명 */}
                        <td className="p-2.5 font-sans font-bold whitespace-nowrap min-w-[110px]">
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition whitespace-nowrap text-xs">
                              {getStockName(item.symbol, item.name)}
                            </span>
                            {getStockName(item.symbol, item.name) !== item.symbol && (
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">
                                {item.symbol}
                              </span>
                            )}
                            {(() => {
                              const mkt = resolveMarketType(item.symbol, item.name, item.market);
                              const isKosdaq = mkt === 'KOSDAQ';
                              return (
                                <>
                                  <span
                                    className={`text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border ${
                                      isKosdaq
                                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                        : 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60'
                                    }`}
                                  >
                                    {isKosdaq ? '코스닥' : '코스피'}
                                  </span>
                                  {item.isCreditAvailable === undefined && (
                                    <span className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-700">
                                      확인필요
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </td>

                        {/* Overlap Specific Columns */}
                        {activeTab === 'overlap' && (
                          <>
                            {/* 중복 수급 주체 Badge */}
                            <td className="p-2.5 font-sans whitespace-nowrap min-w-[110px]">
                              <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap font-bold max-w-full truncate ${badgeStyle.bg}`}>
                                {badgeStyle.label}
                              </span>
                            </td>

                            {/* 주체별 상세 순위 Badges */}
                            <td className="p-2.5 font-sans min-w-[200px]">
                              <div className="flex items-center gap-1 flex-nowrap overflow-x-auto scrollbar-none py-0.5">
                                {item.ranksByType?.map((r) => (
                                  <span
                                    key={r.type}
                                    className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-semibold border whitespace-nowrap shrink-0 ${getInvestorRankBadge(
                                      r.type
                                    )}`}
                                  >
                                    <span>{r.label}</span>
                                    <strong className="font-mono text-[10px]">
                                      {overlapMode === 'consecutive3d'
                                        ? `${r.netBuyAmtEok >= 0 ? '+' : ''}${r.netBuyAmtEok}억`
                                        : `${r.rank}위`}
                                    </strong>
                                  </span>
                                ))}
                              </div>
                            </td>
                          </>
                        )}

                        {/* 종합점수 탭 전용 테이블 컬럼 */}
                        {isComprehensive ? (
                          <>
                            {/* 현재가 */}
                            <td className="p-2.5 text-right font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {item.currentPrice.toLocaleString()} 원
                            </td>

                            {/* 등락률 (상승 빨강 / 하락 파랑) */}
                            <td className="p-2.5 text-right font-bold font-mono whitespace-nowrap">
                              <span className={item.changeRate >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                {item.changeRate >= 0 ? '+' : ''}{item.changeRate.toFixed(2)}%
                              </span>
                            </td>

                            {/* 종합점수 (총점) */}
                            <td className="p-2.5 text-center whitespace-nowrap font-bold">
                              {comprehensiveMode === 'singleSignal' ? (
                                <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-xl text-[11px] font-sans font-black bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs">
                                  {(item as any).topSignalBadge || `${item.scoreBreakdown?.totalScore.toFixed(1)}점`}
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center px-3 py-1 rounded-xl text-sm font-mono font-black bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-xs">
                                  {item.scoreBreakdown?.totalScore.toFixed(1)}점
                                </span>
                              )}
                            </td>

                            {/* 외국인 수급 */}
                            <td className="p-2.5 whitespace-nowrap">
                              {item.foreignSupplyBadge && item.foreignSupplyBadge !== '랭킹 외' ? (
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-md font-bold border inline-flex items-center gap-1 ${
                                    item.foreignSupplyDirection === 'buy'
                                      ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                                      : item.foreignSupplyDirection === 'sell'
                                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60'
                                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                                  }`}
                                >
                                  {item.foreignSupplyBadge}
                                </span>
                              ) : (
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-sans">랭킹 외 (20점)</span>
                              )}
                            </td>

                            {/* 기관 수급 */}
                            <td className="p-2.5 whitespace-nowrap">
                              {item.organSupplyBadge && item.organSupplyBadge !== '랭킹 외' ? (
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-md font-bold border inline-flex items-center gap-1 ${
                                    item.organSupplyDirection === 'buy'
                                      ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                                      : item.organSupplyDirection === 'sell'
                                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60'
                                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                                  }`}
                                >
                                  {item.organSupplyBadge}
                                </span>
                              ) : (
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-sans">랭킹 외 (20점)</span>
                              )}
                            </td>

                            {/* 7개 세부 지표 아코디언 토글 버튼 */}
                            <td className="p-2.5 text-center whitespace-nowrap">
                              <button
                                type="button"
                                onClick={(e) => toggleExpand(item.symbol, e)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition inline-flex items-center gap-1 border cursor-pointer ${
                                  expandedSymbols[item.symbol]
                                    ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                                    : 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800/50 hover:bg-purple-100'
                                }`}
                              >
                                <span>7개 지표</span>
                                {expandedSymbols[item.symbol] ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </button>
                            </td>
                          </>
                        ) : activeTab === 'surging' ? (
                          <>
                            {/* 현재가 */}
                            <td className="p-2.5 text-right font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {item.currentPrice.toLocaleString()} 원
                            </td>

                            {/* 등락률 (상승 빨강 / 하락 파랑) */}
                            <td className="p-2.5 text-right font-bold font-mono whitespace-nowrap">
                              <span className={item.changeRate >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                {item.changeRate >= 0 ? '+' : ''}{item.changeRate.toFixed(2)}%
                              </span>
                            </td>

                            {/* 거래량 */}
                            <td className="p-2.5 text-right font-medium font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.volume.toLocaleString()} 주
                            </td>

                             {/* 거래대금 (억원) - 빨간색 포맷팅 */}
                            <td className="p-2.5 text-right font-bold font-mono text-red-600 dark:text-red-400 whitespace-nowrap">
                              {(item.amountEok || 0).toLocaleString()} 억원
                            </td>

                            {surgingMode === 'overlap' ? (
                              <>
                                {/* 급등 교집합 뱃지 */}
                                <td className="p-2.5 whitespace-nowrap">
                                  <span
                                    className={`text-[10px] px-2 py-0.5 rounded-md font-bold inline-flex items-center gap-1 ${
                                      item.overlapCount && item.overlapCount >= 3
                                        ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs'
                                        : 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700/50'
                                    }`}
                                  >
                                    {item.surgingBadge || `${item.overlapCount || 2}개 일치`}
                                  </span>
                                </td>

                                {/* 외국인 수급 */}
                                <td className="p-2.5 whitespace-nowrap">
                                  {item.foreignSupplyBadge && item.foreignSupplyBadge !== '랭킹 외' ? (
                                    <span
                                      className={`text-[10px] px-2 py-0.5 rounded-md font-bold border inline-flex items-center gap-1 ${
                                        item.foreignSupplyDirection === 'buy'
                                          ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                                          : item.foreignSupplyDirection === 'sell'
                                          ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60'
                                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                                      }`}
                                    >
                                      {item.foreignSupplyBadge}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-400 dark:text-slate-500">랭킹 외</span>
                                  )}
                                </td>

                                {/* 기관 수급 */}
                                <td className="p-2.5 whitespace-nowrap">
                                  {item.organSupplyBadge && item.organSupplyBadge !== '랭킹 외' ? (
                                    <span
                                      className={`text-[10px] px-2 py-0.5 rounded-md font-bold border inline-flex items-center gap-1 ${
                                        item.organSupplyDirection === 'buy'
                                          ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                                          : item.organSupplyDirection === 'sell'
                                          ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60'
                                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                                      }`}
                                    >
                                      {item.organSupplyBadge}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-400 dark:text-slate-500">랭킹 외</span>
                                  )}
                                </td>
                              </>
                            ) : (
                              /* 전일 대비 거래량 증가율 */
                              <td className="p-2.5 text-right font-semibold font-mono text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                                +{(item.volumeIncreaseRate || 0).toFixed(1)}%
                              </td>
                            )}
                          </>
                        ) : (
                          <>
                            {/* 현재가 / 등락률 */}
                            <td className="p-2.5 text-right font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
                              {priceInfo.currentPrice > 0 ? (
                                <>
                                  <div>{priceInfo.currentPrice.toLocaleString()}원</div>
                                  <div
                                    className={`text-[9px] ${
                                      isPriceUp
                                        ? 'text-red-500 font-bold'
                                        : isPriceDown
                                        ? 'text-blue-500 font-bold'
                                        : 'text-slate-400'
                                    }`}
                                  >
                                    ({isPriceUp ? '+' : ''}
                                    {priceInfo.changeRate.toFixed(2)}%)
                                  </div>
                                </>
                              ) : (
                                <div className="flex items-center justify-end gap-1 text-slate-400 text-xs font-sans">
                                  <RefreshCw className="w-3 h-3 animate-spin text-blue-500" />
                                  <span>조회중</span>
                                </div>
                              )}
                            </td>

                            {/* 순매수/순매도 수량 (주) */}
                            <td className="p-2.5 text-right font-medium font-mono whitespace-nowrap text-slate-700 dark:text-slate-300">
                              <span
                                className={`${
                                  isBuy
                                    ? item.netBuyQty >= 0 ? 'text-red-600/90 dark:text-red-400/90' : 'text-blue-600/90 dark:text-blue-400/90'
                                    : item.netBuyQty <= 0 ? 'text-blue-600/90 dark:text-blue-400/90' : 'text-red-600/90 dark:text-red-400/90'
                                }`}
                              >
                                {item.netBuyQty > 0 ? '+' : ''}
                                {item.netBuyQty ? item.netBuyQty.toLocaleString() : '0'}주
                              </span>
                            </td>

                            {/* 합산 또는 단일 순매수 대금 */}
                            <td className="p-2.5 text-right font-bold font-mono whitespace-nowrap">
                              <span
                                className={`${
                                  isBuy
                                    ? item.netBuyAmt >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'
                                    : item.netBuyAmt <= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
                                }`}
                              >
                                {item.netBuyAmt > 0 ? '+' : ''}
                                {item.netBuyAmtEok} 억원
                              </span>
                            </td>
                          </>
                        )}
                      </tr>

                      {/* Accordion Row for In-Place Stock Detail Chart & Score Breakdown Cards */}
                      {expandedSymbols[item.symbol] && (
                        <tr key={`expand-${item.symbol}`} className="bg-slate-50/90 dark:bg-[#181c27]/90 border-b border-purple-200/60 dark:border-purple-900/40">
                          <td colSpan={12} className="p-3.5">
                            <div className="bg-white dark:bg-[#131722] border border-purple-100 dark:border-purple-900/40 rounded-2xl p-4 space-y-4 shadow-inner">
                              {isComprehensive && item.scoreBreakdown && (
                                <>
                                  <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
                                    <span className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                      <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                                      {getStockName(item.symbol, item.name)} ({item.symbol}) — 7개 모멘텀 & 수급 세부 지표 분석 (후보군 {displayList.length}개 중 백분위 점수)
                                    </span>
                                    <span className="text-xs font-mono text-purple-600 dark:text-purple-400 font-black">
                                      종합 총점: {item.scoreBreakdown?.totalScore.toFixed(1)} 점
                                    </span>
                                  </div>

                                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
                                {/* 1. 등락률 (Red) */}
                                <div className="bg-red-50/80 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-red-600 dark:text-red-400 gap-1 whitespace-nowrap">
                                    <span className="text-[11px] font-bold font-sans whitespace-nowrap">1. 등락률</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.flucScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-red-200/80 dark:bg-red-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.flucScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-red-700/80 dark:text-red-300/80 font-mono whitespace-nowrap truncate">
                                    후보군 {item.scoreBreakdown?.flucRank}위 (+{item.changeRate.toFixed(2)}%)
                                  </span>
                                </div>

                                {/* 2. 거래대금 (Amber) */}
                                <div className="bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-amber-600 dark:text-amber-400 gap-1 whitespace-nowrap">
                                    <span className="text-[11px] font-bold font-sans whitespace-nowrap">2. 거래대금</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.amtScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-amber-200/80 dark:bg-amber-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.amtScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-amber-700/80 dark:text-amber-300/80 font-mono whitespace-nowrap truncate">
                                    후보군 {item.scoreBreakdown?.amtRank}위 ({item.amountEok?.toLocaleString()}억)
                                  </span>
                                </div>

                                {/* 3. 거래량증가 (Emerald) */}
                                <div className="bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 gap-1 whitespace-nowrap">
                                     <span className="text-[11px] font-bold font-sans whitespace-nowrap">3. 당일 거래량</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.volIncScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-emerald-200/80 dark:bg-emerald-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.volIncScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-emerald-700/80 dark:text-emerald-300/80 font-mono whitespace-nowrap truncate">
                                     후보군 {item.scoreBreakdown?.volIncRank}위 ({item.volume?.toLocaleString()} 주)
                                  </span>
                                </div>

                                {/* 4. 외국인수급 (Cyan) */}
                                <div className="bg-cyan-50/80 dark:bg-cyan-950/40 border border-cyan-200 dark:border-cyan-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-cyan-600 dark:text-cyan-400 gap-1 whitespace-nowrap">
                                    <span className="text-[11px] font-bold font-sans whitespace-nowrap">4. 외국인수급</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.foreignScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-cyan-200/80 dark:bg-cyan-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.foreignScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-cyan-700/80 dark:text-cyan-300/80 font-mono whitespace-nowrap truncate">
                                    {item.scoreBreakdown?.foreignRank ? `외국인 ${item.scoreBreakdown.foreignRank}위` : '랭킹 외 (20점)'}
                                  </span>
                                </div>

                                {/* 5. 기관수급 (Purple) */}
                                <div className="bg-purple-50/80 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-purple-600 dark:text-purple-400 gap-1 whitespace-nowrap">
                                    <span className="text-[11px] font-bold font-sans whitespace-nowrap">5. 기관수급</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.organScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-purple-200/80 dark:bg-purple-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-purple-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.organScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-purple-700/80 dark:text-purple-300/80 font-mono whitespace-nowrap truncate">
                                    {item.scoreBreakdown?.organRank ? `기관 ${item.scoreBreakdown.organRank}위` : '랭킹 외 (20점)'}
                                  </span>
                                </div>

                                {/* 6. 정배열추세 (Blue) */}
                                <div className="bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-blue-600 dark:text-blue-400 gap-1 whitespace-nowrap">
                                    <span className="text-[11px] font-bold font-sans whitespace-nowrap">6. 정배열추세</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.trendAlignScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-blue-200/80 dark:bg-blue-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.trendAlignScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-blue-700/80 dark:text-blue-300/80 font-mono whitespace-nowrap truncate">
                                    후보군 {item.scoreBreakdown?.trendAlignRank}위 (MA5 &gt; MA60)
                                  </span>
                                </div>

                                {/* 7. 캔들강도 (Rose) */}
                                <div className="bg-rose-50/80 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/40 rounded-xl p-2.5 flex flex-col justify-between space-y-2">
                                  <div className="flex items-center justify-between text-rose-600 dark:text-rose-400 gap-1 whitespace-nowrap">
                                    <span className="text-[11px] font-bold font-sans whitespace-nowrap">7. 캔들강도</span>
                                    <span className="text-xs font-mono font-black shrink-0 whitespace-nowrap">{Math.round(item.scoreBreakdown?.closeStrengthScore || 0)}점</span>
                                  </div>
                                  <div className="w-full h-2 bg-rose-200/80 dark:bg-rose-900/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-rose-500 rounded-full" style={{ width: `${Math.max(item.scoreBreakdown?.closeStrengthScore || 0, 5)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-rose-700/80 dark:text-rose-300/80 font-mono whitespace-nowrap truncate">
                                    마감 강도 {Math.round(item.scoreBreakdown?.closeStrengthScore || 0)}%
                                  </span>
                                </div>
                              </div>
                            </>
                          )}

                              {/* Integrated In-Place Stock Detail Chart (Candlestick + Cumulative Investor Supply Flow) */}
                              <div className={isComprehensive ? "mt-3 pt-3 border-t border-slate-200/80 dark:border-[#2a2e39] w-full" : "w-full"}>
                                <RankingStockDetailChart
                                  symbol={item.symbol}
                                  rank={item.rank}
                                  rankingTypeLabel={activeTabLabel}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                }))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer Info Bar */}
        <div className="pt-3 border-t border-slate-100 dark:border-[#2a2e39] text-xs text-slate-500 dark:text-[#787b86] flex flex-col gap-1.5 shrink-0">
          <div className="flex items-center justify-between">
            <span>
              전체 <strong className="text-slate-900 dark:text-white font-mono">{displayList.length}</strong>개 종목 렌더링
            </span>
            <span className="text-[10px] text-slate-400">마우스 휠로 고정 스크롤</span>
          </div>
          {activeTab === 'surging' ? (
            <div className="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-100/80 dark:bg-[#1a1e29] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 border border-slate-200/60 dark:border-[#2a2e39]">
              <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span>ℹ️ 관리종목(SHD 등)은 KIS API 정책상 본 랭킹에서 제외됩니다.</span>
            </div>
          ) : (
            <div className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-50/70 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300 flex items-center gap-1.5 border border-blue-200/60 dark:border-blue-900/40">
              <Clock className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span>{getIntradaySnapshotNoticeText(hasRealData)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
