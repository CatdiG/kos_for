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
import { getStockName, registerRuntimeStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, TOP_50_STOCKS, resolveMarketType, getSettledAsOfDateLabel, getKrxEstimateSlotInfo } from '@/lib/mockData';
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
  mode: 'daily' | 'consecutive2d' | 'consecutive3d' = 'daily',
  limit: number = 50,
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

  let snapshotLabel = '4차(14:30)';
  let targetTimeStr = '내일 오전 09시 30분';

  if (timeNum < 930) {
    snapshotLabel = '1차 미반영';
    targetTimeStr = '오전 09시 30분';
  } else if (timeNum >= 930 && timeNum < 1120) {
    snapshotLabel = '1차(09:30)';
    targetTimeStr = '오전 11시 20분';
  } else if (timeNum >= 1120 && timeNum < 1320) {
    snapshotLabel = '2차(11:20)';
    targetTimeStr = '오후 1시 20분';
  } else if (timeNum >= 1320 && timeNum < 1430) {
    snapshotLabel = '3차(13:20)';
    targetTimeStr = '오후 2시 30분';
  } else {
    snapshotLabel = '4차(14:30)';
    targetTimeStr = '내일 오전 09시 30분';
  }

  return `ℹ️ [수급 시점 안내] 🟢 외국인 · 기관: 당일 가집계 (${snapshotLabel}) | 🔵 프로그램: 장중 실시간 연동 (다음 갱신: ${targetTimeStr})`;
}

export default function InvestorRankingTable({ selectedSymbol: propSelectedSymbol, chartData, onSelectSymbol }: InvestorRankingTableProps) {
  const [market, setMarket] = useState<MarketType>('ALL');
  const [activeTab, setActiveTab] = useState<RankingType>('surging');
  const [direction, setDirection] = useState<RankingDirection>('buy');
  const [period, setPeriod] = useState<RankingPeriod>('1d');
  const [sortField, setSortField] = useState<keyof RankingItem>('netBuyAmt');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [overlapMode, setOverlapMode] = useState<'daily' | 'consecutive2d' | 'consecutive3d'>('daily');
  const [overlapLimit, setOverlapLimit] = useState<number>(50);
  const [showDropouts, setShowDropouts] = useState<boolean>(false);
  // 이탈 종목 비교 기준: 'today'=오늘 하루 안의 변화, 'yesterday'=직전 영업일 마감 대비(히스토리 페이지와 동일 기준)
  const [dropoutScope, setDropoutScope] = useState<'today' | 'yesterday'>('today');
  const [creditOnly, setCreditOnly] = useState<boolean>(false);
  // 교집합 탭 전용: 이격도 배지가 "단기과열"인 종목(세력매집/설거지주의 모두 포함)을 목록에서 제외해서
  // "지금 바로 진입 검토 가능한" 종목만 골라 보는 필터. 실제 매매 신호가 아니라 이격도 상태 기반 화면 필터일 뿐이다.
  const [entryReadyOnly, setEntryReadyOnly] = useState<boolean>(false);
  const [surgingMode, setSurgingMode] = useState<SurgingMode>('fluctuation');

  // Selected Stock for Right Chart (Single Source of Truth)
  const [internalSymbol, setInternalSymbol] = useState<string>('005930');
  const [selectedRank, setSelectedRank] = useState<number>(1);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const selectedSymbol = propSelectedSymbol || internalSymbol;
  const isSurging = activeTab === 'surging' || activeTab === 'comprehensive';

  const queryClient = useQueryClient();

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
    staleTime: 30 * 1000, // 30s cache staleTime for 0ms instant tab switching
    gcTime: 10 * 60 * 1000,
    // 2일/3일연속 교집합은 콜드스타트 시 상위 30종목만 우선 계산해 isPartial:true로 먼저 응답하고
    // 나머지는 백그라운드에서 이어서 계산한다. isPartial이 true인 동안만 짧게 재조회해서, 완전판이
    // 준비되는 대로 화면이 자동으로 갱신되게 한다(계속 폴링하면 낭비라 완전판이 되면 멈춘다).
    refetchInterval: (query) => {
      const d = query.state.data as InvestorRankingResponse | undefined;
      return d?.isPartial ? 4 * 1000 : false;
    },
  });

  // 2일연속/3일연속 교집합에서 밀려난 "이탈 종목" 조회 - 두 등급을 합쳐서 종목마다 어느 쪽에서 밀려났는지 표시
  type DropoutItem = {
    symbol: string;
    name: string;
    reason: string;
    reasonBadges?: Array<{ type: string; label: string; detail: string }>;
    netBuyAmtEok?: number;
    currentPrice?: number;
    netBuyQty?: number;
    netBuyAmt?: number;
    changeRate?: number;
    droppedAt?: string;
    comparedDate?: string;
    targetDays: 2 | 3;
  };
  const {
    data: dropoutData,
    isLoading: isDropoutLoading,
    isError: isDropoutError,
  } = useQuery<{ list: DropoutItem[] }>({
    queryKey: ['consecutiveOverlapDropouts', direction, market, dropoutScope],
    queryFn: async () => {
      const [res2, res3] = await Promise.all([
        fetch(`/api/stock/consecutive-overlap-dropouts?direction=${direction}&market=${market}&targetDays=2&scope=${dropoutScope}`),
        fetch(`/api/stock/consecutive-overlap-dropouts?direction=${direction}&market=${market}&targetDays=3&scope=${dropoutScope}`),
      ]);
      if (!res2.ok || !res3.ok) throw new Error('이탈 종목 데이터를 가져오는 중 오류가 발생했습니다.');
      const [json2, json3] = await Promise.all([res2.json(), res3.json()]);
      const list2: DropoutItem[] = (json2.list || []).map((d: any) => ({ ...d, targetDays: 2 as const }));
      const list3: DropoutItem[] = (json3.list || []).map((d: any) => ({ ...d, targetDays: 3 as const }));
      const merged = [...list2, ...list3].sort(
        (a, b) => new Date(b.droppedAt || 0).getTime() - new Date(a.droppedAt || 0).getTime()
      );
      return { list: merged };
    },
    enabled: showDropouts && activeTab === 'overlap',
    staleTime: 30 * 1000,
    refetchInterval: showDropouts ? 30 * 1000 : false,
  });

  // Smart hover-based prefetching: Only prefetches the target tab when the user hovers over its button
  const handleTabHover = (tab: RankingType) => {
    if (tab === activeTab) return;
    const key = tab === 'surging' || tab === 'comprehensive'
      ? ['surging', tab === 'comprehensive' ? 'comprehensive' : surgingMode, market]
      : ['ranking', tab, direction, period, overlapMode, overlapLimit, market];

    queryClient.prefetchQuery({
      queryKey: key,
      queryFn: async () => {
        if (tab === 'comprehensive') {
          const res = await fetch(`/api/stock/surging?mode=comprehensive&market=${market}`);
          return res.json();
        }
        if (tab === 'surging') {
          const res = await fetch(`/api/stock/surging?mode=${surgingMode}&market=${market}`);
          return res.json();
        }
        return fetchRanking(tab, direction, period, overlapMode, overlapLimit, market);
      },
      staleTime: 30 * 1000,
    });
  };

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

      const signalScores = [
        { key: 'fluc', label: '🔥 등락률 1위', score: flucScore },
        { key: 'volInc', label: '⚡ 거래량 1위', score: volIncScore },
        { key: 'amt', label: '💰 거래대금 1위', score: amtScore },
      ].sort((a, b) => b.score - a.score);

      const topSignal = signalScores[0];

      return {
        ...item,
        topSignalBadge: `${topSignal.label} (${topSignal.score.toFixed(0)}점)`,
        scoreBreakdown: {
          ...item.scoreBreakdown,
          totalScore: dynamicTotal,
        },
      };
    });
  }

  // 3. Sort the FULL Unfiltered List according to active mode & sort fields
  fullList = [...fullList].sort((a, b) => {
    if (isComprehensive) {
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
        return isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
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

  // 5-1. 교집합 탭 "진입가능만" 필터: 이격도 배지가 단기과열(세력매집/설거지주의 불문) 또는 역배열인
  // 종목을 제외한다. 역배열은 추세 자체가 하락이라 연속매수가 바닥매집인지 단순반등인지 구분이 안 되는
  // 별개의 리스크라, 백엔드 AI픽 후보군 배제 기준(kisApi.ts의 isEntryReadyBadge)과 동일하게 맞춘다.
  if (activeTab === 'overlap' && entryReadyOnly) {
    displayList = displayList
      .filter((item) => {
        const badge = item.statusBadge || '';
        return !badge.includes('단기과열') && !badge.includes('역배열');
      })
      .map((item, idx) => ({
        ...item,
        rank: idx + 1, // 필터링 후 순위 재정렬(1, 2, 3...)
      }));
  }

  const hasRealData = useMemo(() => {
    if (!displayList || displayList.length === 0) return false;
    return displayList.some((item) => (item.netBuyAmt || 0) !== 0 || (item.netBuyQty || 0) !== 0);
  }, [displayList]);

  // Track context key (activeTab, direction, period, overlapMode, overlapLimit, market, creditOnly, entryReadyOnly)
  const contextKey = `${activeTab}-${direction}-${period}-${overlapMode}-${overlapLimit}-${market}-${creditOnly}-${entryReadyOnly}`;
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
      setEntryReadyOnly(false); // 진입가능 필터도 탭 전환 시 초기화
      if (newTab !== 'overlap') {
        setOverlapMode('daily');
        setOverlapLimit(50);
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
      setEntryReadyOnly(false);
    }
  };

  const handleDirectionChange = (newDir: RankingDirection) => {
    if (newDir !== direction) {
      setDirection(newDir);
      setExpandedSymbols({});
      setCreditOnly(false);
      setEntryReadyOnly(false);
    }
  };

  const handlePeriodChange = (newPeriod: RankingPeriod) => {
    if (newPeriod !== period) {
      setPeriod(newPeriod);
      setExpandedSymbols({});
      setCreditOnly(false);
      setEntryReadyOnly(false);
    }
  };

  // Reset expanded accordion charts whenever ANY tab, sub-mode, badge, filter, or sorting condition changes
  useEffect(() => {
    setExpandedSymbols({});
  }, [activeTab, surgingMode, market, direction, period, overlapMode, overlapLimit, weights, creditOnly, entryReadyOnly, sortField, sortAsc]);

  const tabs: { id: RankingType; label: string; icon: any; isRealtime: boolean; badge?: string }[] = [
    { id: 'surging', label: '급등주', icon: Rocket, isRealtime: true, badge: 'LIVE' },
    { id: 'comprehensive', label: '단타 종합랭킹', icon: Trophy, isRealtime: true, badge: 'SCORE' },
    { id: 'foreign', label: '외국인', icon: Globe2, isRealtime: true },
    { id: 'organ', label: '기관', icon: Landmark, isRealtime: true },
    { id: 'program', label: '프로그램', icon: Cpu, isRealtime: false },
    { id: 'overlap', label: '수급교집합', icon: Flame, isRealtime: true, badge: 'HOT' },
  ];

  const activeTabLabel = tabs.find((t) => t.id === activeTab)?.label || '순위';

  const getOverlapBadgeStyle = (count: number) => {
    if (count >= 3) {
      return {
        label: '3주체 일치',
        bg: 'bg-gradient-to-r from-purple-600 to-pink-600 text-white font-black shadow-xs',
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
      case 'program':
        return 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/40';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  };

  const rawProgramAsOf = (data as any)?.programTrade?.asOfDateLabel || (data as any)?.summary?.program?.asOfDateLabel || (data as any)?.lastBatchTime || getSettledAsOfDateLabel();
  const rawForeignAsOf = (data as any)?.asOfDateLabel || (data as any)?.summary?.foreign?.asOfDateLabel || (data as any)?.list?.[0]?.asOfDateLabel || getSettledAsOfDateLabel();
  const rawOrganAsOf = (data as any)?.asOfDateLabel || (data as any)?.summary?.organ?.asOfDateLabel || (data as any)?.list?.[0]?.asOfDateLabel || getSettledAsOfDateLabel();

  const formatParenLabel = (str: string) => {
    const clean = str.replace(/^\((.*)\)$/, '$1');
    return `(${clean})`;
  };

  // KRX 공식 잠정 가집계 공표 차수 (단일 공통 함수 getKrxEstimateSlotInfo 활용)
  const krxSlotInfo = getKrxEstimateSlotInfo();
  const isMarketOpenNow = krxSlotInfo.isMarketOpen;
  const latestKrxSlotTime = krxSlotInfo.currentSlot.time;
  const nextKrxSlotTime = krxSlotInfo.nextSlotTime;

  const isAllSettled = (rawForeignAsOf.includes('마감') || (/^\([0-9]+\/[0-9]+.*기준\)$/.test(rawForeignAsOf))) &&
    (rawOrganAsOf.includes('마감') || (/^\([0-9]+\/[0-9]+.*기준\)$/.test(rawOrganAsOf))) &&
    (rawProgramAsOf.includes('마감') || (/^\([0-9]+\/[0-9]+.*기준\)$/.test(rawProgramAsOf)));

  const foreignOrganPart = rawForeignAsOf === rawOrganAsOf
    ? (isMarketOpenNow && rawForeignAsOf.includes('가집계') ? `외·기 (${latestKrxSlotTime} 기준 갱신, 다음 갱신 ${nextKrxSlotTime})` : `외·기 ${formatParenLabel(rawForeignAsOf)}`)
    : `외 ${formatParenLabel(rawForeignAsOf)} · 기 ${formatParenLabel(rawOrganAsOf)}`;

  let dynamicNoticeText = '';
  if (activeTab === 'surging') {
    dynamicNoticeText = '실시간 등락률 · 거래량 · 거래대금 체결 기준 (60초 자동 갱신)';
  } else if (activeTab === 'comprehensive') {
    dynamicNoticeText = '7대 모멘텀 & 확증 지표 실시간 종합 스코어링 (60초 자동 갱신)';
  } else {
    dynamicNoticeText = isAllSettled
      ? `${formatParenLabel(rawForeignAsOf)} 전 주체 종가 정산 완료`
      : `${foreignOrganPart} · 프 ${formatParenLabel(rawProgramAsOf)}`;
  }

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
                  {overlapMode === 'consecutive3d'
                    ? '3일연속 수급교집합'
                    : (overlapMode === 'consecutive2d' ? '2일연속 수급교집합' : '당일 수급교집합')}
                </span>
              )}
              {activeTab === 'overlap' && overlapMode !== 'daily' && data?.isPartial && (
                <span
                  className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-slate-600 text-white flex items-center gap-1 shadow-xs whitespace-nowrap shrink-0"
                  title="상위 후보부터 먼저 계산해서 우선 보여드리고 있습니다. 나머지 종목도 몇 초 안에 이어서 채워집니다."
                >
                  <RefreshCw className="w-3 h-3 shrink-0 animate-spin" />
                  상위 종목 우선 표시 중 (전체 계산 중...)
                </span>
              )}
              {activeTab === 'surging' && (
                <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-gradient-to-r from-red-600 to-orange-500 text-white flex items-center gap-1 shadow-xs animate-pulse whitespace-nowrap shrink-0">
                  <Zap className="w-3 h-3 shrink-0" />
                  실시간 60초 자동 갱신
                </span>
              )}
              {activeTab === 'comprehensive' && (
                <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center gap-1 shadow-xs animate-pulse whitespace-nowrap shrink-0">
                  <Zap className="w-3 h-3 shrink-0" />
                  실시간 종합 스코어링
                </span>
              )}
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 flex items-center gap-1 whitespace-nowrap shrink-0 font-mono">
                <Clock className="w-3 h-3 shrink-0" />
                {dynamicNoticeText}
              </span>
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
                    onMouseEnter={() => handleTabHover(tab.id)}
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

          {/* KRX Official Provisional Estimates Timeline Bar (수급 탭 전용 나열형 뱃지 복원) */}
          {!isSurging && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-slate-100 dark:border-[#2a2e39]/60 text-xs">
              <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5">
                <span className="font-bold text-slate-500 dark:text-slate-400 shrink-0 flex items-center gap-1">
                  🏛️ KRX 잠정 공표 일정:
                </span>
                {(krxSlotInfo.schedule || []).map((slot, sIdx) => {
                  const isPassed = krxSlotInfo.timeNum >= slot.timeNum;
                  const nextSlot = krxSlotInfo.schedule?.[sIdx + 1];
                  const isCurrent = isPassed && (!nextSlot || krxSlotInfo.timeNum < nextSlot.timeNum);
                  return (
                    <span
                      key={slot.time}
                      className={`px-2 py-0.5 rounded-md font-mono text-[10px] shrink-0 border transition flex items-center gap-1 ${
                        isCurrent
                           ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700 font-bold shadow-xs'
                          : isPassed
                          ? 'bg-slate-100 dark:bg-[#1e222d] text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39]'
                          : 'bg-transparent text-slate-400 dark:text-slate-600 border-dashed border-slate-200 dark:border-[#2a2e39]'
                      }`}
                    >
                      <span className="text-[9px] font-sans text-slate-500 dark:text-slate-400">{slot.step}</span>
                      <strong className="font-mono">{slot.time}</strong>
                      {isCurrent ? <span className="text-[8px] bg-emerald-600 text-white px-1 py-0.2 rounded font-sans">최신</span> : isPassed ? '✓' : ''}
                    </span>
                  );
                })}
              </div>
              <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono shrink-0">
                * 다음 갱신 예정: <strong className="text-slate-700 dark:text-slate-300">{krxSlotInfo.nextSlotTime}</strong>
              </span>
            </div>
          )}
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <Trophy className="w-4 h-4 text-amber-500 shrink-0 animate-bounce" />
                  <span className="text-xs font-bold text-slate-900 dark:text-white mr-1">
                    가중치 프리셋:
                  </span>
                  
                  {/* Preset Buttons */}
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setWeights(DEFAULT_WEIGHTS)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer border ${
                        weights.fluc === 10 && weights.volInc === 50 && weights.amt === 20 && weights.trendAlign === 10 && weights.closeStrength === 10
                          ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                          : 'bg-white/80 dark:bg-[#131722]/80 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39] hover:bg-slate-100'
                      }`}
                    >
                      <span>⚖️ 기본 밸런스</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setWeights({
                          fluc: 33,
                          volInc: 33,
                          amt: 34,
                          foreign: 0,
                          organ: 0,
                          trendAlign: 0,
                          closeStrength: 0,
                        })
                      }
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer border ${
                        weights.fluc === 33 && weights.volInc === 33 && weights.amt === 34 && weights.foreign === 0 && weights.organ === 0
                          ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white border-red-600 shadow-xs'
                          : 'bg-white/80 dark:bg-[#131722]/80 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39] hover:bg-slate-100'
                      }`}
                    >
                      <span>⚡ 모멘텀 3지표 집중</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setWeights({
                          fluc: 10,
                          volInc: 20,
                          amt: 20,
                          foreign: 25,
                          organ: 25,
                          trendAlign: 0,
                          closeStrength: 0,
                        })
                      }
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer border ${
                        weights.foreign === 25 && weights.organ === 25
                          ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                          : 'bg-white/80 dark:bg-[#131722]/80 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39] hover:bg-slate-100'
                      }`}
                    >
                      <span>🌊 수급 확증형</span>
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
            <div className="flex flex-wrap items-center gap-2 pt-2.5 border-t border-purple-100 dark:border-purple-950/40">
              {/* Overlap Mode Toggle + 이탈 종목 버튼을 같은 줄에 바로 붙여서 배치(justify-between으로 멀어지지 않게) */}
              <div className="bg-purple-50 dark:bg-purple-950/40 p-1 rounded-xl flex items-center text-xs font-medium border border-purple-200 dark:border-purple-800/40 max-w-full overflow-hidden gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => { setOverlapMode('daily'); setShowDropouts(false); }}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    overlapMode === 'daily' && !showDropouts
                      ? 'bg-purple-600 text-white shadow-xs'
                      : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                  }`}
                >
                  <Flame className="w-3 h-3 shrink-0" />
                  당일 교집합
                </button>
                <button
                  type="button"
                  onClick={() => { setOverlapMode('consecutive2d'); setShowDropouts(false); }}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    overlapMode === 'consecutive2d' && !showDropouts
                      ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-xs'
                      : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                  }`}
                >
                  <Zap className="w-3 h-3 shrink-0" />
                  <span>2일연속 교집합</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setOverlapMode('consecutive3d'); setShowDropouts(false); }}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    overlapMode === 'consecutive3d' && !showDropouts
                      ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs animate-pulse'
                      : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                  }`}
                >
                  <Rocket className="w-3 h-3 shrink-0" />
                  <span>3일연속 교집합</span>
                </button>
                {/* 이탈 종목 - 3일연속 교집합 버튼 바로 옆, 같은 pill 안에 붙여서 배치 */}
                <button
                  type="button"
                  onClick={() => setShowDropouts(true)}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    showDropouts
                      ? 'bg-gradient-to-r from-slate-600 to-slate-700 text-white shadow-xs'
                      : 'text-purple-700 dark:text-purple-300 hover:text-purple-900'
                  }`}
                  title="2일연속/3일연속 명단에서 오늘 밀려난 종목과 사유를 봅니다"
                >
                  <TrendingDown className="w-3 h-3 shrink-0" />
                  <span>이탈 종목</span>
                </button>
              </div>

              {/* 이탈 비교 기준 토글 - 이탈 종목 패널이 켜져 있을 때만 노출 */}
              {showDropouts && (
                <div className="bg-slate-100 dark:bg-[#1e222d] p-1 rounded-xl flex items-center border border-slate-200/60 dark:border-[#2a2e39] text-xs shrink-0">
                  <button
                    type="button"
                    onClick={() => setDropoutScope('today')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition whitespace-nowrap cursor-pointer ${
                      dropoutScope === 'today'
                        ? 'bg-slate-700 text-white shadow-xs'
                        : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                    title="오늘 하루 안에서 밀려난 종목만 봅니다"
                  >
                    당일 이탈
                  </button>
                  <button
                    type="button"
                    onClick={() => setDropoutScope('yesterday')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition whitespace-nowrap cursor-pointer ${
                      dropoutScope === 'yesterday'
                        ? 'bg-slate-700 text-white shadow-xs'
                        : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                    title="직전 영업일 마감 대비 밀려난 종목을 봅니다 (히스토리 페이지와 동일 기준)"
                  >
                    어제의 이탈
                  </button>
                </div>
              )}

              {/* 진입가능만 필터 - 이격도 배지가 단기과열 또는 역배열인 종목은 화면에서 숨긴다(신용가능 필터와 동일 배치 방식) */}
              {!showDropouts && (
                <button
                  type="button"
                  onClick={() => setEntryReadyOnly(!entryReadyOnly)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                    entryReadyOnly
                      ? 'bg-emerald-600 text-white border-transparent shadow-xs font-black'
                      : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                  title="이격도 배지가 '단기과열' 또는 '역배열'인 종목을 목록에서 제외합니다 (매매 신호가 아니라 화면 필터입니다)"
                >
                  <Filter className={`w-3.5 h-3.5 ${entryReadyOnly ? 'text-emerald-200' : 'text-emerald-500'}`} />
                  <span>진입가능만</span>
                </button>
              )}
            </div>
          )}

          {/* 이탈 종목(밀려난 종목) 패널 - "이탈 종목" 버튼을 켜면 아래 순위표 대신 이것만 단독으로 보임.
              "당일 교집합" 순위표와 동일한 스타일(순위/종목명/현재가/순매수 수량/합산 순매수)을 그대로 쓰고,
              "주체별 상세 순위" 칸만 "이탈 이유"로 바꿔서 보여준다. */}
          {activeTab === 'overlap' && showDropouts && (
            isDropoutLoading ? (
              <div className="py-8 text-center text-[11px] text-slate-400 flex items-center justify-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                이탈 종목 확인 중...
              </div>
            ) : isDropoutError ? (
              <div className="p-6 text-center text-xs text-red-500 bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900">
                이탈 종목 데이터를 불러오지 못했습니다. 다시 시도해 주세요.
              </div>
            ) : !dropoutData?.list || dropoutData.list.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-[#1e222d]/30 rounded-xl border border-dashed border-slate-200 dark:border-[#2a2e39]">
                {dropoutScope === 'yesterday'
                  ? '직전 영업일 마감 대비 이탈한 종목이 없습니다.'
                  : '아직 오늘 이탈한 종목이 없습니다 (직전 조회 대비 명단이 그대로 유지되고 있습니다).'}
              </div>
            ) : (
              <div className="overflow-y-auto max-h-[740px] rounded-xl border border-slate-200 dark:border-[#2a2e39] scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-700">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29] shadow-xs">
                    <tr className="border-b border-slate-200 dark:border-[#2a2e39] text-slate-500 dark:text-[#787b86] font-semibold bg-slate-100 dark:bg-[#1a1e29]">
                      <th className="p-2.5 text-center min-w-[50px] whitespace-nowrap shrink-0 sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">순위</th>
                      <th className="p-2.5 whitespace-nowrap min-w-[110px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">종목명</th>
                      <th className="p-2.5 whitespace-nowrap min-w-[200px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">이탈 이유</th>
                      <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                      <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">{isBuy ? '순매수 수량' : '순매도 수량'}</th>
                      <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">{isBuy ? '합산 순매수' : '합산 순매도'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#2a2e39]/60 font-mono">
                  {dropoutData.list.map((d, idx) => {
                    const rank = idx + 1;
                    // 다른 탭과 동일하게 handleStockSelect가 item.symbol 기준으로 펼침 상태를 관리한다
                    const isExpanded = Boolean(expandedSymbols[d.symbol]);
                    const changeRate = d.changeRate || 0;
                    const isPriceUp = changeRate > 0;
                    const isPriceDown = changeRate < 0;
                    return (
                      <React.Fragment key={`${d.symbol}-${d.targetDays}`}>
                        <tr
                          className="transition-colors cursor-pointer hover:bg-slate-50 dark:hover:bg-[#1e222d]"
                          onClick={(e) => handleStockSelect(e, { symbol: d.symbol, name: d.name, rank, type: 'overlap' } as RankingItem)}
                        >
                          {/* 순위 */}
                          <td className="p-2.5 text-center font-bold whitespace-nowrap">
                            <span
                              className={`inline-flex items-center justify-center w-5 h-5 rounded-md text-[10px] shrink-0 ${
                                rank === 1
                                  ? 'bg-amber-500 text-white font-black shadow-xs'
                                  : rank === 2
                                  ? 'bg-slate-400 text-white font-bold'
                                  : rank === 3
                                  ? 'bg-amber-700 text-white font-bold'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {rank}
                            </span>
                          </td>

                          {/* 종목명 */}
                          <td className="p-2.5 font-sans font-bold whitespace-nowrap min-w-[110px]">
                            <div className="flex items-center gap-1.5">
                              <span className="text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition whitespace-nowrap text-xs">
                                {getStockName(d.symbol, d.name)}
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">{d.symbol}</span>
                              {(() => {
                                const mkt = resolveMarketType(d.symbol, d.name);
                                const isKosdaq = mkt === 'KOSDAQ';
                                return (
                                  <span
                                    className={`text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border ${
                                      isKosdaq
                                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                        : 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60'
                                    }`}
                                  >
                                    {isKosdaq ? '코스닥' : '코스피'}
                                  </span>
                                );
                              })()}
                            </div>
                          </td>

                          {/* 이탈 이유 (당일 교집합의 "주체별 상세 순위" 자리) - 2/3일연속 탭과 동일한 배지 형식 */}
                          <td className="p-2.5 font-sans min-w-[200px]">
                            <div className="flex items-center gap-1 flex-wrap py-0.5">
                              <span
                                className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap shrink-0 text-white ${
                                  d.targetDays === 3
                                    ? 'bg-gradient-to-r from-red-600 to-amber-600 border-transparent'
                                    : 'bg-gradient-to-r from-blue-600 to-indigo-600 border-transparent'
                                }`}
                              >
                                {d.targetDays}일연속
                              </span>
                              {d.reasonBadges && d.reasonBadges.length > 0 ? (
                                d.reasonBadges.map((b, i) => (
                                  <span
                                    key={`${b.type}-${i}`}
                                    className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-semibold border whitespace-nowrap shrink-0 ${getInvestorRankBadge(b.type)}`}
                                  >
                                    <span>{b.label}</span>
                                    <strong className="font-mono text-[10px]">{b.detail}</strong>
                                  </span>
                                ))
                              ) : d.reason && d.reason !== '이탈' ? (
                                <span className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded font-semibold border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900/40 whitespace-nowrap shrink-0">
                                  {d.reason}
                                </span>
                              ) : (
                                <span className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded font-semibold border border-dashed border-slate-300 dark:border-slate-700 text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-slate-900/40 whitespace-nowrap shrink-0">
                                  이탈
                                </span>
                              )}
                            </div>
                          </td>

                          {/* 현재가 */}
                          <td className="p-2.5 text-right font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
                            {(d.currentPrice || 0) > 0 ? (
                              <>
                                <div>{(d.currentPrice || 0).toLocaleString()}원</div>
                                <div className={`text-[9px] ${isPriceUp ? 'text-red-500 font-bold' : isPriceDown ? 'text-blue-500 font-bold' : 'text-slate-400'}`}>
                                  ({isPriceUp ? '+' : ''}{changeRate.toFixed(2)}%)
                                </div>
                              </>
                            ) : (
                              <span className="text-slate-400 text-[10px]">-</span>
                            )}
                          </td>

                          {/* 순매수/순매도 수량 (주) */}
                          <td className="p-2.5 text-right font-medium font-mono whitespace-nowrap text-slate-700 dark:text-slate-300">
                            {d.netBuyQty === undefined || d.netBuyQty === null ? (
                              <span className="text-slate-400 text-[10px]">-</span>
                            ) : (
                              <span className={`${isBuy ? (d.netBuyQty >= 0 ? 'text-red-600/90 dark:text-red-400/90' : 'text-blue-600/90 dark:text-blue-400/90') : (d.netBuyQty <= 0 ? 'text-blue-600/90 dark:text-blue-400/90' : 'text-red-600/90 dark:text-red-400/90')}`}>
                                {d.netBuyQty > 0 ? '+' : ''}
                                {d.netBuyQty.toLocaleString()}주
                              </span>
                            )}
                          </td>

                          {/* 합산 순매수 대금 */}
                          <td className="p-2.5 text-right font-bold font-mono whitespace-nowrap">
                            <span className={`${isBuy ? ((d.netBuyAmt || 0) >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400') : ((d.netBuyAmt || 0) <= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400')}`}>
                              {(d.netBuyAmt || 0) > 0 ? '+' : ''}
                              {d.netBuyAmtEok ?? 0} 억원
                            </span>
                          </td>
                        </tr>

                        {/* 다른 탭들과 동일하게: 행을 누르면 그 자리에 종목 상세 차트가 펼쳐짐 */}
                        {isExpanded && (
                          <tr className="bg-slate-50/90 dark:bg-[#181c27]/90 border-b border-purple-200/60 dark:border-purple-900/40">
                            <td colSpan={6} className="p-3.5">
                              <div className="bg-white dark:bg-[#131722] border border-purple-100 dark:border-purple-900/40 rounded-2xl p-4 shadow-inner">
                                <RankingStockDetailChart symbol={d.symbol} rank={rank} rankingTypeLabel="이탈 종목" />
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* Ranking Table Content with Fixed Height & Internal Vertical Scroll */}
          {/* 이탈 종목 패널이 켜져 있으면(showDropouts) 아래 순위표 전체를 렌더링하지 않고 위 패널만 단독 표시 */}
          {showDropouts ? null : isLoading ? (
            <div className="h-64 flex flex-col items-center justify-center gap-2 text-slate-400 dark:text-slate-500 text-xs animate-pulse">
              <RefreshCw className="w-6 h-6 animate-spin" />
              <span>
                {overlapMode === 'consecutive3d'
                  ? '3일 연속 수급 교집합 데이터 분석 중...'
                  : (overlapMode === 'consecutive2d' ? '2일 연속 수급 교집합 데이터 분석 중...' : '매매 순위 데이터를 로딩하는 중입니다...')}
              </span>
            </div>
          ) : isError ? (
            <div className="p-6 text-center text-xs text-red-500 bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900">
              랭킹 데이터를 불러오지 못했습니다. 다시 시도해 주세요.
            </div>
          ) : displayList.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-[#1e222d]/30 rounded-xl border border-dashed border-slate-200 dark:border-[#2a2e39]">
              {activeTab === 'overlap'
                ? (overlapMode !== 'daily'
                    ? `${overlapMode === 'consecutive2d' ? '2일' : '3일'} 이상 연속 수급이 2개 이상 주체에서 동시에 진행 중인 종목이 없습니다.`
                    : '조건에 부합하는 수급 교집합 종목 데이터가 없습니다.')
                : `${activeTabLabel} ${isBuy ? '순매수' : '순매도'}${market !== 'ALL' ? ` (${market === 'KOSPI' ? '코스피' : '코스닥'})` : ''} 조건에 부합하는 종목 데이터가 없습니다.`}
            </div>
          ) : (
            /* Fixed Height Scroll Container */
            <div ref={tableContainerRef} className="overflow-y-auto max-h-[740px] rounded-xl border border-slate-200 dark:border-[#2a2e39] scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-700">
              <table className="w-full text-left border-collapse text-xs">
                {/* Sticky Header */}
                <thead className="sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29] shadow-xs">
                  <tr className="border-b border-slate-200 dark:border-[#2a2e39] text-slate-500 dark:text-[#787b86] font-semibold bg-slate-100 dark:bg-[#1a1e29]">
                    <th className="p-2.5 text-center min-w-[50px] whitespace-nowrap shrink-0 sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">순위</th>
                    <th className="p-2.5 whitespace-nowrap min-w-[110px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">종목명</th>

                    {activeTab === 'overlap' ? (
                      <th className="p-2.5 whitespace-nowrap min-w-[200px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">
                        {overlapMode === 'consecutive3d' ? '주체별 연속 순매수' : '주체별 상세 순위'}
                      </th>
                    ) : null}

                    {isComprehensive ? (
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">종합점수 (총점)</th>
                        <th className="p-2.5 whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">외국인 수급</th>
                        <th className="p-2.5 whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">기관 수급</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">7개 세부 지표</th>
                      </>
                    ) : activeTab === 'surging' ? (
                      surgingMode === 'overlap' ? (
                        <>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">거래량</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">거래대금</th>
                          <th className="p-2.5 whitespace-nowrap min-w-[180px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">급등 상세 순위</th>
                          <th className="p-2.5 whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">외국인 수급</th>
                          <th className="p-2.5 whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">기관 수급</th>
                        </>
                      ) : (
                        <>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">거래량</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">거래대금</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">전일대비 거래량</th>
                        </>
                      )
                    ) : (
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">
                          <button type="button" onClick={() => handleSort('currentPrice')} className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer">
                            현재가
                            <ArrowUpDown className="w-3 h-3 opacity-60 shrink-0" />
                          </button>
                        </th>

                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">
                          <button type="button" onClick={() => handleSort('netBuyQty')} className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer font-semibold text-slate-600 dark:text-slate-400">
                            {isBuy ? '순매수 수량' : '순매도 수량'}
                            <ArrowUpDown className="w-3 h-3 opacity-60 shrink-0" />
                          </button>
                        </th>

                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">
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
                  {displayList.map((item) => {
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
                            <div className="relative inline-flex items-center justify-center shrink-0">
                              {/* 게임 티어 표준 5색 및 1위(30px)~5위(10px) 5px 단위 차등 단일 별(Star) 엠블럼 */}
                              {/* 당일 교집합뿐 아니라 2일/3일연속 교집합도 백엔드에서 이미 동일한 computeOverlapAiPickScore로
                                  aiPickRank를 계산해두고 있으므로(kisApi.ts의 fetchConsecutiveNDaysOverlapRankingData),
                                  overlapMode 종류와 무관하게 항상 별 뱃지를 노출한다 */}
                              {activeTab === 'overlap' && item.aiPickRank && item.aiPickRank <= 5 && (
                                <div
                                  className={`absolute z-[2] pointer-events-none transform -rotate-45 origin-center shrink-0 filter drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)] ${
                                    item.aiPickRank === 1
                                      ? '-top-3 -left-3'
                                      : item.aiPickRank === 2
                                      ? '-top-2.5 -left-2.5'
                                      : item.aiPickRank === 3
                                      ? '-top-2 -left-2'
                                      : item.aiPickRank === 4
                                      ? '-top-1.5 -left-1.5'
                                      : '-top-0.5 -left-0.5'
                                  }`}
                                  title={`AI 수급 추천 ${item.aiPickRank}위`}
                                >
                                  <svg
                                    width={
                                      item.aiPickRank === 1
                                        ? '30'
                                        : item.aiPickRank === 2
                                        ? '25'
                                        : item.aiPickRank === 3
                                        ? '20'
                                        : item.aiPickRank === 4
                                        ? '15'
                                        : '10'
                                    }
                                    height={
                                      item.aiPickRank === 1
                                        ? '30'
                                        : item.aiPickRank === 2
                                        ? '25'
                                        : item.aiPickRank === 3
                                        ? '20'
                                        : item.aiPickRank === 4
                                        ? '15'
                                        : '10'
                                    }
                                    viewBox="0 0 22 22"
                                    fill="none"
                                    className="shrink-0 animate-in fade-in duration-200 opacity-80"
                                  >
                                    <path
                                      d="M11 1l2.8 5.7 6.3.9-4.5 4.4 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.5-4.4 6.3-.9L11 1z"
                                      fill={
                                        item.aiPickRank === 1
                                          ? '#FFE600' /* 1위: 30px 선명한 퓨어 골드 */
                                          : item.aiPickRank === 2
                                          ? '#E2E8F0' /* 2위: 25px 플래티넘 실버 */
                                          : item.aiPickRank === 3
                                          ? '#EA580C' /* 3위: 20px 코퍼 브론즈 */
                                          : item.aiPickRank === 4
                                          ? '#38BDF8' /* 4위: 15px 스틸 사파이어/블루 */
                                          : '#D946EF' /* 5위: 10px 마스터 퍼플 */
                                      }
                                      stroke={
                                        item.aiPickRank === 1
                                          ? '#CA8A04' /* 1위: 순수 짙은 옐로우/진노랑 테두리 */
                                          : item.aiPickRank === 2
                                          ? '#64748B' /* 실버 톤온톤 슬레이트 테두리 */
                                          : item.aiPickRank === 3
                                          ? '#9A3412' /* 브론즈 톤온톤 딥코퍼 테두리 */
                                          : item.aiPickRank === 4
                                          ? '#0284C7' /* 블루 톤온톤 딥사파이어 테두리 */
                                          : '#86198F' /* 퍼플 톤온톤 딥푸시아 테두리 */
                                      }
                                      strokeWidth="1.6"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </div>
                              )}

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
                            </div>
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
                                <span
                                  className={`text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border ${
                                    isKosdaq
                                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60'
                                      : 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60'
                                  }`}
                                >
                                  {isKosdaq ? '코스닥' : '코스피'}
                                </span>
                              );
                            })()}
                          </div>
                        </td>

                         {/* Overlap Specific Columns */}
                        {activeTab === 'overlap' && (
                          <td className="p-2.5 font-sans min-w-[200px]">
                            <div className="flex items-center gap-1 flex-nowrap overflow-x-auto scrollbar-none py-0.5">
                              <span
                                className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap shrink-0 ${
                                  item.statusBadgeStyle || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                                }`}
                                title={item.statusBadge || '⚪ 이평선 수렴'}
                              >
                                {item.statusBadge || '⚪ 이평선 수렴'}
                              </span>
                              {[...(item.ranksByType || [])]
                                .sort((a, b) => {
                                  const isConsecA = overlapMode !== 'daily' && (a.consecutiveDays || 0) >= 2 ? 1 : 0;
                                  const isConsecB = overlapMode !== 'daily' && (b.consecutiveDays || 0) >= 2 ? 1 : 0;
                                  if (isConsecB !== isConsecA) return isConsecB - isConsecA;
                                  const order: Record<string, number> = { foreign: 1, organ: 2, program: 3 };
                                  return (order[a.type] || 99) - (order[b.type] || 99);
                                })
                                .map((r) => {
                                  const isSubTarget = overlapMode !== 'daily' && r.isRanked === false;
                                  return (
                                    <span
                                      key={r.type}
                                      className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-semibold border whitespace-nowrap shrink-0 ${
                                        isSubTarget
                                          ? 'border-slate-300 dark:border-slate-600 bg-slate-100/70 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 opacity-90'
                                          : getInvestorRankBadge(r.type)
                                      }`}
                                    >
                                      <span>{r.label}</span>
                                      <strong className="font-mono text-[10px]">
                                        {overlapMode !== 'daily'
                                          ? (r.consecutiveText || (r.consecutiveDays && r.consecutiveDays >= 2 ? `${r.consecutiveDays}일연속` : '당일순매수'))
                                          : (r.isRanked === false || !r.rank || r.rank <= 0
                                              ? '순위밖'
                                              : `${r.rank}위`)}
                                      </strong>
                                    </span>
                                  );
                                })}
                              {item.missingEntities?.map((m) => (
                                <span
                                  key={m.type}
                                  className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded font-semibold border border-dashed border-slate-300 dark:border-slate-700 text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-slate-900/40 opacity-70 whitespace-nowrap shrink-0 cursor-help"
                                  title={`${m.label}: 당일 순매수 상위 순위 미진입`}
                                >
                                  <span>{m.label}: 미달</span>
                                </span>
                              ))}
                              {/* 당일 최초 진입 시각 - 뱃지 열의 제일 뒤에 배치("당일 교집합" 모드에서만 의미가 있다) */}
                              {overlapMode === 'daily' && item.firstSeenLabel && (
                                <span
                                  className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-semibold border whitespace-nowrap shrink-0 bg-cyan-50 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800/60"
                                  title="오늘 이 종목이 당일 교집합 명단에 처음 포착된 시각"
                                >
                                  <Clock className="w-2.5 h-2.5 shrink-0" />
                                  {item.firstSeenLabel}
                                </span>
                              )}
                              </div>
                            </td>
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
                              <span className="inline-flex items-center justify-center px-3 py-1 rounded-xl text-sm font-mono font-black bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-xs">
                                {item.scoreBreakdown?.totalScore.toFixed(1)}점
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
                  })}
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
          {activeTab === 'surging' && (
            <div className="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-100/80 dark:bg-[#1a1e29] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 border border-slate-200/60 dark:border-[#2a2e39]">
              <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span>ℹ️ 관리종목(SHD 등)은 KIS API 정책상 본 랭킹에서 제외됩니다.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
