'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
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
import { getStockName, registerRuntimeStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, resolveMarketType, getSettledAsOfDateLabel, getKrxEstimateSlotInfo } from '@/lib/mockData';
import { fetchReclaimWatchSignals, ReclaimWatchSignal } from '@/lib/vwapReclaimClient';
import { VwapReclaimSignal, PivotReclaimSignal } from '@/lib/types';
import RankingStockDetailChart from './RankingStockDetailChart';
import CreditShieldIcon from './CreditShieldIcon';
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
  Target,
  Star,
  Compass,
  Radar,
} from 'lucide-react';

interface InvestorRankingTableProps {
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string, item?: RankingItem) => void;
}

async function fetchRanking(
  type: RankingType,
  direction: RankingDirection,
  period: RankingPeriod,
  mode: 'daily' | 'consecutive2d' | 'consecutive3d' = 'daily',
  limit: number = 50,
  market: MarketType = 'ALL',
  // 🚨 [기능 재설계 - "토글 필터로 진행해줘"] mode(기준 탭)와 독립된 쿼리 파라미터 - 당일/2일연속/
  // 3일연속 어느 탭에서든 켤 수 있다(수칙 1-6, route.ts와 동일 파라미터명).
  quietFilter: boolean = false
): Promise<InvestorRankingResponse> {
  const res = await fetch(
    `/api/stock/ranking?type=${type}&direction=${direction}&period=${period}&mode=${mode}&limit=${limit}&market=${market}${quietFilter ? '&quietFilter=1' : ''}`
  );
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '매매 순위 데이터를 가져오는 중 오류가 발생했습니다.');
  }
  return res.json();
}

export default function InvestorRankingTable({ selectedSymbol: propSelectedSymbol, onSelectSymbol }: InvestorRankingTableProps) {
  const [market, setMarket] = useState<MarketType>('ALL');
  const [activeTab, setActiveTab] = useState<RankingType>('surging');
  const [direction, setDirection] = useState<RankingDirection>('buy');
  const [period, setPeriod] = useState<RankingPeriod>('1d');
  const [sortField, setSortField] = useState<keyof RankingItem>('netBuyAmt');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [overlapMode, setOverlapMode] = useState<'daily' | 'consecutive2d' | 'consecutive3d'>('daily');
  const [overlapLimit, setOverlapLimit] = useState<number>(50);
  // 🚨 [기능 재설계 - 사용자 요청: "토글 필터로 진행해줘"] 예전엔 "수급 장마감 후보군"이 overlapMode의
  // 네 번째 값(3일연속 전용)이었는데, 실측 백테스트로 이 필터가 당일/2일연속/3일연속 어디서나 유효하다는
  // 게 확인돼(kisApi.ts의 applyQuietAccumulationFilter 주석 참고) 기준 탭과 독립된 토글로 분리했다.
  const [quietAccumFilter, setQuietAccumFilter] = useState<boolean>(false);
  const [showDropouts, setShowDropouts] = useState<boolean>(false);
  // 이탈 종목 비교 기준: 'today'=오늘 하루 안의 변화, 'yesterday'=직전 영업일 마감 대비(히스토리 페이지와 동일 기준)
  const [dropoutScope, setDropoutScope] = useState<'today' | 'yesterday'>('today');
  const [creditOnly, setCreditOnly] = useState<boolean>(false);
  // 교집합 탭 전용: 이격도 배지가 "단기과열"인 종목(세력매집/설거지주의 모두 포함)을 목록에서 제외해서
  // "지금 바로 진입 검토 가능한" 종목만 골라 보는 필터. 실제 매매 신호가 아니라 이격도 상태 기반 화면 필터일 뿐이다.
  const [entryReadyOnly, setEntryReadyOnly] = useState<boolean>(false);
  const [surgingMode, setSurgingMode] = useState<SurgingMode>('fluctuation');
  // 🎯 [기능 추가 - 사용자 요청: "탭을 왔다갔다 하면서 보는게 너무 귀찮은데... 셀렉터까지 원해"] 급등주
  // 교집합에서 등락률(3%+)·거래량·거래대금 중 몇 개 이상 겹쳐야 노출할지 선택 - 기본값 2는 기존 동작과
  // 동일해서 "처음 열릴 때는 기존 상태 유지"를 만족한다.
  const [overlapMinCount, setOverlapMinCount] = useState<number>(2);
  // 🎯 [재설계 - 사용자 요청: "실시간으로 봐야 유리하지", "더 빠르게"] 급등주/수급교집합 화면 공통
  // 실시간 감시 토글 - 켜면 화면에 뜬 후보 전체(최대 60개)를 짧은 주기로 계속 갱신한다(종목당 1콜짜리
  // 가벼운 방식으로 바뀌어서 5개로 좁힐 필요 없음). react-query의 queryKey가 탭/서브모드마다 다르므로,
  // 조회 도중 탭이 바뀌어도 이전 결과가 새 화면에 잘못 반영되는 경쟁 상태가 구조적으로 발생하지 않는다.
  const [vwapWatchEnabled, setVwapWatchEnabled] = useState<boolean>(false);
  // 🎯 [기능 추가 - 사용자 요청: "R2까지 안가고 R1까지 뚫었어도... 다시 올라올거 같은 반등"] VWAP와
  // 별개의 감시 토글 - 전일 확정 피봇 저항선(R1·R2)을 뚫었다가 눌린 뒤 재도전하는 종목을 잡는다.
  const [pivotWatchEnabled, setPivotWatchEnabled] = useState<boolean>(false);

  // Selected Stock for Right Chart (Single Source of Truth)
  const [internalSymbol, setInternalSymbol] = useState<string>('005930');
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const selectedSymbol = propSelectedSymbol || internalSymbol;
  // 🚨 [기능 추가 - 관심종목 탭] watchlist도 여기 포함시켜서 순매수/순매도 토글·기간 필터·KRX 공표
  // 일정 배지(수급 데이터 전용, 관심종목엔 안 맞음) 등 !isSurging 조건부 UI가 자동으로 숨겨지게 한다.
  // discovery/precursor도 postmarket과 동일하게 순매수 개념이 없는 "장마감 후보군" 그룹이라 포함한다.
  const isSurging = activeTab === 'surging' || activeTab === 'comprehensive' || activeTab === 'postmarket' || activeTab === 'discovery' || activeTab === 'precursor' || activeTab === 'watchlist';
  // 🚨 [기능 추가 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로"] 급등 장마감
  // (postmarket)·발굴 장마감(discovery)·전조 장마감(precursor) 3개를 화면엔 "장마감 후보군" 탭 하나로
  // 보여주고, 내부적으로만 이 3개 값 사이를 토글한다 - activeTab 자체는 그대로 셋 중 하나를 유지한다
  // (데이터 조회·컬럼 렌더링 로직을 안 건드리고 탭 버튼 표시만 합치기 위함, 수칙 1-6).
  const isPostMarketGroup = activeTab === 'postmarket' || activeTab === 'discovery' || activeTab === 'precursor';

  const queryClient = useQueryClient();

  // 🎯 [기능 추가 - 사용자 요청: "꼭 관심종목 버튼을 눌러야만 하는거야?"] 종목 상세 화면까지 안 들어가도
  // 어느 탭에서든 종목명 옆 별(⭐) 아이콘 하나로 바로 추가/제거되게 한다. RankingStockDetailChart.tsx의
  // 동일 queryKey('ws-watchlist')를 그대로 써서 두 컴포넌트가 별도 호출 없이 캐시를 공유한다.
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
      // 🚨 [버그 수정 - 사용자 지적: "관심종목에 바로 생기고 없어지고 할수없냐"] 별 아이콘 상태(ws-watchlist)만
      // 갱신하면 "관심종목" 탭 자체의 목록 쿼리(['surging','watchlist',market,null])는 30초 자동갱신을
      // 기다려야 한다. queryKey를 짧게 주면 react-query가 뒤에 오는 market 등과 무관하게 다 매칭한다.
      await queryClient.invalidateQueries({ queryKey: ['surging', 'watchlist'] });
    } finally {
      setWsWatchlistTogglingSymbol(null);
    }
  };

  const { data, isLoading, isError, refetch, isFetching } = useQuery<InvestorRankingResponse>({
    queryKey: activeTab === 'discovery'
      ? ['discovery', market]
      : activeTab === 'precursor'
      ? ['precursor', market]
      : isSurging
      ? ['surging', activeTab === 'comprehensive' ? 'comprehensive' : activeTab === 'postmarket' ? 'postmarket' : activeTab === 'watchlist' ? 'watchlist' : surgingMode, market, surgingMode === 'overlap' ? overlapMinCount : null]
      : ['ranking', activeTab, direction, period, overlapMode, overlapLimit, market, quietAccumFilter],
    queryFn: async () => {
      // 🚨 [기능 추가 - "발굴 장마감" 탭] cron이 미리 계산해둔 오늘자 스냅샷만 읽는다(라이브 재계산 없음).
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
      if (activeTab === 'comprehensive') {
        const res = await fetch(`/api/stock/surging?mode=comprehensive&market=${market}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '종합랭킹 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      // 🚨 [기능 추가 - 사용자 요청: "장마감 후보군을 단타종합랭킹-외국인 사이 최상위 탭으로"] comprehensive와
      // 동일 패턴 - surgingMode 서브탭 선택과 무관하게 이 탭 자체가 항상 postmarket 데이터를 가져온다.
      if (activeTab === 'postmarket') {
        const res = await fetch(`/api/stock/surging?mode=postmarket&market=${market}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '장마감 후보군 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      // 🚨 [기능 추가 - 사용자 요청: "관심종목으로 누른 종목들 관심종목으로 따로 빼줘"] comprehensive/
      // postmarket과 동일 패턴 - isSurging(아래)의 surgingMode 서브탭 분기를 타지 않도록 그 앞에서 먼저 처리.
      if (activeTab === 'watchlist') {
        const res = await fetch('/api/stock/watchlist-ranking');
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '관심종목 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      if (isSurging) {
        const minOverlapParam = surgingMode === 'overlap' ? `&minOverlap=${overlapMinCount}` : '';
        const res = await fetch(`/api/stock/surging?mode=${surgingMode}&market=${market}${minOverlapParam}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || '급등주 순위 데이터를 가져오는 중 오류가 발생했습니다.');
        }
        return res.json();
      }
      return fetchRanking(activeTab, direction, period, overlapMode, overlapLimit, market, activeTab === 'overlap' && quietAccumFilter);
    },
    staleTime: 30 * 1000, // 30s cache staleTime for 0ms instant tab switching
    gcTime: 10 * 60 * 1000,
    // 2일/3일연속 교집합은 콜드스타트 시 상위 30종목만 우선 계산해 isPartial:true로 먼저 응답하고
    // 나머지는 백그라운드에서 이어서 계산한다. isPartial이 true인 동안만 짧게 재조회해서, 완전판이
    // 준비되는 대로 화면이 자동으로 갱신되게 한다(계속 폴링하면 낭비라 완전판이 되면 멈춘다).
    // program 탭도 동일 패턴: 콜드스타트 직후엔 트렌드 예열(after() 25종목/사이클, 사이클당 약 45초)이
    // 덜 끝나 더미 시그니처가 남아있을 수 있다(stillWarming:true) - 그동안만 50초 간격으로 재조회해서
    // 예열 사이클이 끝나는 대로 자동 반영되게 하고, 다 채워지면(stillWarming:false) 폴링을 멈춘다.
    refetchInterval: (query) => {
      const d = query.state.data as InvestorRankingResponse | undefined;
      if (d?.isPartial) return 4 * 1000;
      if (activeTab === 'program' && d?.stillWarming) return 50 * 1000;
      if (activeTab === 'watchlist') return 30 * 1000; // 관심종목은 실시간 현재가라 30초마다 자동 갱신
      return false;
    },
  });

  // 🎯 [재설계] 지금 화면에 뜬 후보 전체를 15초 주기로 계속 갱신 - queryKey에 탭/서브모드/시장 등 화면을
  // 결정짓는 값이 전부 들어있어서, 조회 도중 탭이 바뀌면 react-query가 그 시점 이후로는 이전 queryKey의
  // 응답을 새 화면에 반영하지 않는다(수동 토큰 관리 불필요 - 예전 온디맨드 버전에서 겪었던 경쟁 상태가
  // 구조적으로 발생할 수 없음).
  // 🚨 [버그 수정 - 사용자 지적: "영원히 로딩중인데?" 프로덕션 실측(kos-for.vercel.app)으로 발견]
  // data?.list의 종목 "순서"는 서버리스 인스턴스마다 미세하게 다르게 캐시돼 있어서(같은 종목 구성이라도
  // 정렬 결과가 흔들릴 수 있음) 요청마다 바뀔 수 있는데, 정렬 안 된 vwapWatchSymbols.join(',')를 그대로
  // queryKey에 넣으면 순서가 바뀔 때마다 react-query가 "완전히 새로운 쿼리"로 오인해 staleTime:0과
  // 맞물려 응답이 오기도 전에 다음 요청을 또 새로 시작 - 500개 넘는 요청이 순식간에 몰리는 무한 루프가
  // 되어 화면이 계속 "로딩 중"으로 보였다(실측: Network 탭에 동일 순간 512개+ 요청). 감시 대상은
  // "이 종목들의 집합"이지 "이 순서"가 아니므로, 정렬해서 순서 변화만으로는 키가 안 바뀌게 한다.
  const vwapWatchSymbols = (data?.list || []).map((item) => item.symbol).filter(Boolean);
  const vwapWatchSymbolsKey = [...vwapWatchSymbols].sort().join(',');
  // 🎯 [기능 추가] R1/R2 재돌파 감시. VWAP과 독립적으로 켜고 끌 수 있고, 둘 다 켜도 같이 볼 수 있다
  // (사용자 확인: "각각해도 다 같이 볼수있는거지?").
  // 🎯 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] VWAP watch와 Pivot watch는 항상 같은 종목
  // 리스트·같은 15초 주기로 함께 쓰이는데, 예전엔 쿼리 2개가 서로 다른 API 라우트(별도 서버리스 함수)를
  // 때려서 같은 종목 현재가를 KIS에 중복으로 물어봤다 - 하나의 쿼리로 합쳐서 근본 해결한다(수칙 1-6).
  // 🚨 [버그 수정 - 사용자 지적: "장마감 후보군은 감시신호 왜있어?"] 토글 버튼 자체는 activeTab ===
  // 'surging' 또는 (activeTab === 'overlap' && !showDropouts)일 때만 화면에 렌더링되는데, 이 값은 그
  // 판단 없이 vwapWatchEnabled/pivotWatchEnabled 상태만 봤다 - 급등주 탭에서 감시를 켜둔 채로 장마감
  // 후보군(또는 외국인/기관/프로그램 등) 탭으로 이동해도 꺼질 방법이 없어 감시 신호 열과 API 호출이
  // 그대로 따라갔다. 토글이 실제로 보이는 탭에서만 감시가 살아있도록 맞춘다.
  // 🚨 [기능 추가 - 사용자 요청: "장마감 후보군 탭에도 VWAP 실시간 감시, 피봇 재돌파 감시 넣어줘"]
  // 예전엔 "장마감 후보군 등 다른 탭엔 안 새어나간다"고 의도적으로 막아뒀는데, 이번 요청으로 그 제한을 푼다.
  const watchTogglesVisible = activeTab === 'surging' || isPostMarketGroup || (activeTab === 'overlap' && !showDropouts);
  const reclaimWatchEnabled = watchTogglesVisible && (vwapWatchEnabled || pivotWatchEnabled);
  const { data: reclaimWatchMap, isFetching: reclaimWatchFetching } = useQuery<Map<string, ReclaimWatchSignal>>({
    queryKey: ['reclaim-watch', activeTab, surgingMode, market, direction, period, overlapMode, overlapLimit, quietAccumFilter, vwapWatchSymbolsKey],
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
    const key = tab === 'surging' || tab === 'comprehensive' || tab === 'postmarket'
      ? ['surging', tab === 'comprehensive' ? 'comprehensive' : tab === 'postmarket' ? 'postmarket' : surgingMode, market]
      : ['ranking', tab, direction, period, overlapMode, overlapLimit, market];

    queryClient.prefetchQuery({
      queryKey: key,
      queryFn: async () => {
        if (tab === 'comprehensive') {
          const res = await fetch(`/api/stock/surging?mode=comprehensive&market=${market}`);
          return res.json();
        }
        if (tab === 'postmarket') {
          const res = await fetch(`/api/stock/surging?mode=postmarket&market=${market}`);
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

  // 급등주 교집합(surgingMode==='overlap') 전용 - "거래대금" 헤더를 누르면 거래대금 높은 순으로,
  // 한 번 더 누르면(오름차순이 아니라) 원래의 정상 순서(백엔드 rank 기준)로 되돌아간다. 다른 정보(현재가/
  // 등락률/거래량/급등 상세 순위 등)는 그대로 두고 행 순서만 바뀐다 - handleSort의 "같은 필드 재클릭 시
  // 오름차순으로 토글"과는 다른, 이 버튼 전용의 2단계(거래대금 내림차순 ↔ 정상) 토글이 필요해서 분리했다.
  const handleOverlapAmountSortToggle = () => {
    if (sortField === 'amountEok') {
      setSortField('netBuyAmt');
      setSortAsc(false);
    } else {
      setSortField('amountEok');
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
        } else if (surgingMode === 'overlap') {
          // 급등주 교집합의 "정상" 순서 - 백엔드가 이미 계산해서 내려준 원래 rank(교집합 개수 기준)
          // 그대로. 아래 464번째 줄에서 정렬 후 rank를 1,2,3...으로 재할당하기 전이라 이 시점의
          // a.rank/b.rank는 API가 원래 내려준 순위값이다.
          return (a.rank || 0) - (b.rank || 0);
        }
      }
      // 🚨 [기능 추가 - 사용자 요청] 장마감 후보군은 이제 surging 서브탭이 아니라 최상위 activeTab이라
      // 위 surging 분기 밖에서 따로 처리한다 - postMarketScore 기준으로 백엔드가 이미 정렬해준 순서 유지.
      if (activeTab === 'postmarket') {
        return (a.rank || 0) - (b.rank || 0);
      }
      // 🚨 [기능 재설계 - "장마감 후보만" 토글] 이 필터가 켜져 있으면 overlapCount 단순 내림차순이 아니라
      // postMarketScore(백테스트로 검증한 역발상 점수) 기준으로 백엔드가 이미 정렬해준 순서를 그대로
      // 유지해야 한다 - 바로 위 postmarket 탭과 동일 원칙(수칙 1-6). 어느 기준 탭(당일/2일/3일연속)이든
      // 이 필터가 켜져 있으면 적용되므로, 아래 일반 'overlap' 분기보다 먼저 걸러내야 한다.
      if (activeTab === 'overlap' && quietAccumFilter) {
        return (a.rank || 0) - (b.rank || 0);
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

  // 5-2. [기능 추가 - 사용자 요청: "재돌파 확인 눌렀을때도 종목이 뜨면 원래 몇위였는지 보여줘"] 버튼을
  // 누른 상태(vwapReclaimMap이 존재)면 신호가 뜬 종목만 남기고, 필터링 전 순위를 vwapOriginalRank에
  // 스냅샷으로 남겨둔 뒤 순위를 재정렬한다 - 다른 필터들과 동일한 재정렬 관례(수칙 1-6).
  // 🚨 [버그 수정 - 사용자 지적: "다시 눌러서 끄면 원래 탭으로 안 돌아옴"] react-query는 enabled가
  // false가 돼도 마지막으로 받아온 데이터를 그대로 들고 있는다 - vwapReclaimMap 존재 여부만으로 필터를
  // 걸었더니, 토글을 꺼도 예전 데이터가 남아있어서 필터가 계속 걸려있었다. 반드시 vwapWatchEnabled가
  // 켜져 있을 때만 필터를 적용한다.
  // 🚨 [버그 수정 - 실측: 성호전자가 reclaimed:true인데도 화면에서 사라짐] signal(=reclaimed&&volSurge)로
  // 걸러서 노출 기준을 잡았더니, 이미 확인된 재돌파(reclaimed)가 거래량 조건 하나 때문에 통째로 숨겨졌다.
  // "재돌파했는지"와 "거래량까지 확인됐는지"는 별개 정보이므로, 노출 기준은 reclaimed 자체로 하고
  // volSurge는 배지에 부가 정보로만 표시한다(숨기지 않음).
  // 🎯 [기능 추가 - 사용자 확인: "각각해도 다 같이 볼수있는거지?"] VWAP 감시와 피봇(R1/R2) 감시를 둘 다
  // 켜면 OR로 합쳐서 보여준다 - 둘 중 하나라도 걸리면 노출.
  const vwapWatchActive = watchTogglesVisible && vwapWatchEnabled && !!vwapReclaimMap;
  const pivotWatchActive = watchTogglesVisible && pivotWatchEnabled && !!pivotReclaimMap;
  // 🎯 [기능 추가 - 사용자 요청: "남겨두자. 그리고 그걸 순위 밑으로두자. 진입가능한건 맨위의 순위로
  // 뜨게 하고"] 예전엔 approaching/reclaimed가 아니면 통째로 필터링해서, "오늘 한 번 뚫었다가 지금은
  // 다시 아래"인 종목(hadPriorReclaim/hadPriorBreak)이 화면에서 완전히 사라졌다(= "떴다 사라진다"는
  // 불만의 원인). 5단계 우선순위 점수 하나로 환산해서, 액션 가능한 순서대로 위에서 아래로 정렬한다:
  // 4=임박(지금이 진입 타이밍, 왔다갔다 적음) > 3=완료(이미 뚫림, 참고용, 왔다갔다 적음) >
  // 2=잦은 등락(오늘 4회 이상 왔다갔다 - VWAP 근처 노이즈성이라 신뢰도 낮지만 지금 활동 중이긴 함) >
  // 1=이전 이력만(지금은 완전히 잠잠함, 대기 중) > 0=오늘 신호 이력 전혀 없음(제외).
  // VWAP·피봇 둘 다 켜져 있으면 더 강한 신호 쪽 점수를 취한다.
  // 🚨 [기능 추가 - 사용자 지적: "성호전자도 계속 재돌파했다가 재돌파임박 했다가... 꾸준하게 있다가
  // 재돌파하는 종목들을 보고싶은데"] 실측(Supabase watch_signal_state): 성호전자 오늘 VWAP crossCount
  // 12회 - 진짜 방향성 돌파가 아니라 VWAP 선 근처에서 계속 왕복하는 노이즈였다. crossCount 분포를
  // 실측(197개 종목)한 결과 90 백분위수가 정확히 4회라서, 상위 10%에 해당하는 "유별나게 왔다갔다하는"
  // 종목만 4회 기준으로 걸러낸다(사용자 확인). 피봇(R1/R2)은 아직 crossCount를 추적하지 않아
  // (DB 스키마 추가 필요) 이 등급이 적용되지 않는다.
  const FREQUENT_FLIP_CROSS_COUNT = 4;
  // 🚨 [기능 추가 - 사용자 지적: "2번은 횟수에 따라서 정렬시켜"] 잦은 등락(우선순위 2) 묶음 안에서도
  // 4회짜리와 18회짜리가 뒤섞여 있었다 - crossCount를 2차 정렬 키로 써서 같은 우선순위 안에서는
  // 왔다갔다 적은(더 믿을만한) 종목이 위로 오게 한다.
  const getWatchPriority = (item: RankingItem): { priority: number; crossCount: number } => {
    const v = vwapWatchActive ? vwapReclaimMap!.get(item.symbol) : undefined;
    const vActive = !!(v?.approaching || v?.reclaimed);
    const vCrossCount = v?.crossCount ?? 0;
    const vFrequentFlip = vActive && vCrossCount >= FREQUENT_FLIP_CROSS_COUNT;
    const vPriority = vFrequentFlip ? 2 : v?.approaching ? 4 : v?.reclaimed ? 3 : v?.hadPriorReclaim ? 1 : 0;
    const p = pivotWatchActive ? pivotReclaimMap!.get(item.symbol) : undefined;
    const pLevel = p && (p.r2.approaching || p.r2.reclaimed || p.r2.hadPriorBreak) ? p.r2 : p?.r1;
    const pPriority = pLevel?.approaching ? 4 : pLevel?.reclaimed ? 3 : pLevel?.hadPriorBreak ? 1 : 0;
    return vPriority >= pPriority
      ? { priority: vPriority, crossCount: vCrossCount }
      : { priority: pPriority, crossCount: 0 }; // 피봇은 아직 crossCount 미추적
  };
  if (vwapWatchActive || pivotWatchActive) {
    displayList = displayList
      .map((item) => ({ item, ...getWatchPriority(item) }))
      .filter(({ priority }) => priority > 0)
      .sort((a, b) => b.priority - a.priority || a.crossCount - b.crossCount || a.item.rank - b.item.rank)
      .map(({ item }, idx) => ({
        ...item,
        vwapOriginalRank: item.rank,
        rank: idx + 1,
      }));
  }

  // Track context key (activeTab, direction, period, overlapMode, overlapLimit, market, creditOnly, entryReadyOnly, quietAccumFilter)
  const contextKey = `${activeTab}-${direction}-${period}-${overlapMode}-${overlapLimit}-${market}-${creditOnly}-${entryReadyOnly}-${quietAccumFilter}`;
  const prevContextKey = useRef('');

  useEffect(() => {
    if (isFetching) return;

    if (prevContextKey.current !== contextKey && displayList && displayList.length > 0) {
      prevContextKey.current = contextKey;
      const firstItem = displayList[0];
      setInternalSymbol(firstItem.symbol);
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
        setQuietAccumFilter(false);
      }
      // 급등주 교집합 "거래대금" 정렬을 켜둔 채로 다른 탭으로 넘어가면 그 탭엔 amountEok가 없거나
      // 의미가 달라서 정렬이 이상하게 보일 수 있어 정상 순서로 되돌린다.
      if (sortField === 'amountEok') {
        setSortField('netBuyAmt');
        setSortAsc(false);
      }
    }
  };

  const handleSurgingModeChange = (mode: SurgingMode) => {
    if (mode !== surgingMode) {
      setSurgingMode(mode);
      setExpandedSymbols({}); // Reset open accordion stock detail charts
      setCreditOnly(false); // Reset credit filter OFF when switching surging sub-tabs
      // 급등주 교집합에서 "거래대금" 정렬을 켜둔 채로 다른 서브탭(등락률/거래량 등)으로 넘어가면, 거기엔
      // amountEok가 없거나 의미가 달라서 정렬이 이상하게 보일 수 있어 정상 순서로 되돌린다.
      if (sortField === 'amountEok') {
        setSortField('netBuyAmt');
        setSortAsc(false);
      }
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
  // 🚨 [기능 재설계] vwapWatchEnabled는 여기서 초기화하지 않는다 - 탭을 옮겨도 "감시 모드" 자체는 계속
  // 켜진 채로 유지하고, react-query의 queryKey가 탭 정보를 포함하므로 감시 대상만 새 탭 목록으로 자동
  // 전환된다(수동 리셋/토큰 관리 불필요 - 예전 온디맨드 버전의 경쟁 상태 버그가 구조적으로 없어짐).
  useEffect(() => {
    setExpandedSymbols({});
  }, [activeTab, surgingMode, market, direction, period, overlapMode, overlapLimit, weights, creditOnly, entryReadyOnly, sortField, sortAsc, quietAccumFilter]);

  const tabs: { id: RankingType; label: string; icon: any; isRealtime: boolean; badge?: string }[] = [
    { id: 'surging', label: '급등주', icon: Rocket, isRealtime: true, badge: 'LIVE' },
    { id: 'comprehensive', label: '단타 종합랭킹', icon: Trophy, isRealtime: true, badge: 'SCORE' },
    // 🚨 [기능 추가 - 사용자 요청: "관심종목으로 누른 종목들 관심종목으로 따로 빼줘. 단타종합랭킹이랑
    // 장마감 후보군 사이에"] 종목 상세(RankingStockDetailChart)의 "실시간" 토글로 등록한 관심종목
    // (ws_watchlist, 오라클 웹소켓 브릿지 구독 대상과 동일 목록)의 현재가를 보여주는 탭.
    { id: 'watchlist', label: '관심종목', icon: Star, isRealtime: true },
    // 🚨 [기능 통합 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로"] 원래 급등
    // 장마감(postmarket)·발굴 장마감(discovery)·전조 장마감(precursor) 3개 탭이었는데, 화면엔 이 하나로
    // 합치고 내부 토글(급등/발굴/전조)로 전환한다 - isPostMarketGroup/POSTMARKET_SUBMODES 참고.
    // id는 postmarket을 대표값으로 쓴다(처음 클릭 시 기본 서브모드).
    { id: 'postmarket', label: '장마감 후보군', icon: Target, isRealtime: false, badge: 'NEW' },
    { id: 'foreign', label: '외국인', icon: Globe2, isRealtime: true },
    { id: 'organ', label: '기관', icon: Landmark, isRealtime: true },
    { id: 'program', label: '프로그램', icon: Cpu, isRealtime: false },
    { id: 'overlap', label: '수급교집합', icon: Flame, isRealtime: true, badge: 'HOT' },
  ];

  const activeTabLabel = tabs.find((t) => t.id === activeTab)?.label || '순위';

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

  // 🚨 [버그 수정 - 사용자 지적: "수급 장마감 후보군 누르면 전체·코스피·코스닥·신용가능 버튼들이 다른
  // 탭들과 다른 위치에 있어"] overlap 탭엔 왼쪽에 이미 "수급 장마감 후보군" 그라디언트 배지(672~681번
  // 줄)가 떠 있는데, 여기에 이 branch의 긴 안내 문구까지 더해지면 왼쪽 영역 폭이 너무 길어져 flex-wrap
  // 컨테이너가 오른쪽 시장/신용 필터 버튼을 다음 줄로 밀어내며 좌측 정렬로 떨어뜨렸다(실측: 1440px
  // 폭에서 title/배지 y=-239.5인데 "전체" 버튼만 y=-198.5·x=127로 다음 줄 좌측에 위치). 사용자 요청대로
  // 이 별도 문구 자체를 없애고 다른 수급교집합 서브모드(당일/2일/3일연속)와 동일하게 아래 else 분기의
  // 짧은 문구(외국인/기관/프로그램 정산 시각)를 그대로 쓰게 해 폭을 통일한다.
  let dynamicNoticeText = '';
  if (activeTab === 'postmarket') {
    dynamicNoticeText = '급등주 교집합 중 R2 근접도(변동폭·고가권 마감) · 기관 지속매수 기준 다음 거래일 후보 (5분 캐시)';
  } else if (activeTab === 'surging') {
    dynamicNoticeText = '실시간 등락률 · 거래량 · 거래대금 체결 기준 (60초 자동 갱신)';
  } else if (activeTab === 'comprehensive') {
    dynamicNoticeText = '7대 모멘텀 & 확증 지표 실시간 종합 스코어링 (60초 자동 갱신)';
  } else if (activeTab === 'watchlist') {
    dynamicNoticeText = '종목 상세 화면의 "실시간" 버튼으로 등록한 관심종목 (30초 자동 갱신, 오라클 웹소켓 브릿지 구독 대상과 동일)';
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
                  {quietAccumFilter ? <Target className="w-3 h-3 shrink-0" /> : overlapMode === 'consecutive3d' ? <Rocket className="w-3 h-3 shrink-0" /> : <Zap className="w-3 h-3 shrink-0" />}
                  {overlapMode === 'consecutive3d'
                    ? '3일연속 수급교집합'
                    : (overlapMode === 'consecutive2d' ? '2일연속 수급교집합' : '당일 수급교집합')}
                  {/* 🚨 [기능 재설계 - "토글 필터로 진행해줘"] "수급 장마감 후보군"이 별도 탭이 아니라 이
                      토글이 됐으니, 기준 탭 이름 뒤에 필터가 켜져 있다는 걸 이어붙여 보여준다. */}
                  {quietAccumFilter && ' · 장마감 후보만'}
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
                // "장마감 후보군" 탭 버튼은 activeTab이 postmarket/discovery/precursor 중 무엇이든 활성 표시.
                const isActive = tab.id === 'postmarket' ? isPostMarketGroup : activeTab === tab.id;
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
            // 🚨 [버그 수정 - 사용자 지적: "VWAP 실시간 감시를 피봇 재돌파 옆으로 좀 붙여"] justify-between이
            // 넓은 화면에서 서브모드 pill/VWAP버튼/피봇버튼 3개를 양끝으로 흩어놓고 있었다. 수급교집합
            // 탭(아래쪽 "Dedicated Sub-Controls Bar")은 이미 이 문제를 피해 gap-2만 쓰고 있으니 동일하게 맞춘다.
            <div className="flex flex-wrap items-center gap-2 pt-2.5 border-t border-red-100 dark:border-red-950/40">
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
                  급등주 교집합 ({overlapMinCount}개+)
                </button>
              </div>
              {/* 🎯 [기능 추가 - 사용자 요청: "탭을 왔다갔다 하면서 보는게 너무 귀찮은데... 셀렉터까지
                  원해. 처음 급등주교집합이 열릴때는 기존상태를 유지해서 열리게"] 등락률·거래량·거래대금
                  탭을 일일이 옮겨다니지 않아도, 교집합 탭 하나에서 몇 개 이상 겹칠 때 보여줄지 직접
                  고른다. 기본값 2가 기존 동작과 동일하다. */}
              {surgingMode === 'overlap' && (
                <div className="bg-slate-100 dark:bg-[#1e222d] p-1 rounded-xl flex items-center text-xs font-medium border border-slate-200/60 dark:border-[#2a2e39] gap-0.5 shrink-0">
                  <span className="text-[10px] text-slate-400 font-bold px-1 shrink-0">겹침 기준:</span>
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setOverlapMinCount(n)}
                      className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold shrink-0 ${
                        overlapMinCount === n
                          ? 'bg-red-600 text-white shadow-xs'
                          : 'text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {n}개+
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setVwapWatchEnabled((v) => !v)}
                className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                  vwapWatchEnabled
                    ? 'bg-gradient-to-r from-sky-600 to-cyan-600 text-white border-transparent shadow-xs font-black'
                    : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                }`}
                title="켜면 지금 보이는 후보 전체를 15초 주기로 계속 갱신해서, 재돌파 임박(아직 미돌파+간격 좁혀짐+거래량 선행) 또는 재돌파 완료 종목을 실시간으로 표시합니다"
              >
                <Zap className={`w-3.5 h-3.5 ${vwapWatchEnabled ? 'text-sky-200' : 'text-sky-600'}`} />
                <span>{vwapWatchEnabled ? 'VWAP 실시간 감시 중' : 'VWAP 실시간 감시'}</span>
                {/* 🚨 [버그 수정 - 사용자 지적: "감시중인거 로딩중이면 로딩인거 알수있게 옆에 둔 도형이라도
                    활용해봐"] 아이콘 자체를 pulse시키는 것만으로는 15초 주기로 다시 조회 중인 순간이 잘
                    안 보였다 - 기존 새로고침 버튼(RefreshCw + animate-spin, 수칙 1-6 재사용)과 동일한
                    패턴으로, isFetching일 때만 옆에 작은 회전 아이콘을 별도로 띄운다. */}
                {vwapWatchEnabled && vwapWatchFetching && <RefreshCw className="w-3 h-3 animate-spin text-sky-100" />}
              </button>
              <button
                type="button"
                onClick={() => setPivotWatchEnabled((v) => !v)}
                className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                  pivotWatchEnabled
                    ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white border-transparent shadow-xs font-black'
                    : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                }`}
                title="켜면 전일 확정 피봇 저항선(R1·R2)을 뚫었다가 눌린 뒤 다시 그 선을 향해 올라오는 종목을 15초 주기로 계속 갱신해서 실시간으로 표시합니다"
              >
                <Target className={`w-3.5 h-3.5 ${pivotWatchEnabled ? 'text-violet-200' : 'text-violet-600'}`} />
                <span>{pivotWatchEnabled ? '피봇 재돌파 감시 중' : '피봇 재돌파 감시'}</span>
                {pivotWatchEnabled && pivotWatchFetching && <RefreshCw className="w-3 h-3 animate-spin text-violet-100" />}
              </button>
            </div>
          )}

          {/* 🚨 [기능 통합 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로 만들고,
              VWAP 실시간 감시·피봇 재돌파 감시도 넣어줘"] 급등/발굴/전조 3개 서브모드 토글 + 위 급등주
              탭과 동일한 VWAP/피봇 감시 버튼(수칙 1-6 - 같은 버튼 JSX를 그대로 재사용). */}
          {isPostMarketGroup && (
            <div className="flex flex-wrap items-center gap-2 pt-2.5 border-t border-amber-100 dark:border-amber-950/40">
              <div className="bg-amber-50 dark:bg-amber-950/30 p-1 rounded-xl flex items-center text-xs font-medium border border-amber-200 dark:border-amber-800/40 max-w-full overflow-hidden gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleTabChange('postmarket')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    activeTab === 'postmarket'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-amber-700 dark:text-amber-300 hover:text-amber-900'
                  }`}
                >
                  <Target className="w-3 h-3 shrink-0" />
                  급등
                </button>
                <button
                  type="button"
                  onClick={() => handleTabChange('discovery')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    activeTab === 'discovery'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-amber-700 dark:text-amber-300 hover:text-amber-900'
                  }`}
                >
                  <Compass className="w-3 h-3 shrink-0" />
                  발굴
                </button>
                <button
                  type="button"
                  onClick={() => handleTabChange('precursor')}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    activeTab === 'precursor'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-amber-700 dark:text-amber-300 hover:text-amber-900'
                  }`}
                >
                  <Radar className="w-3 h-3 shrink-0" />
                  전조
                </button>
              </div>
              <button
                type="button"
                onClick={() => setVwapWatchEnabled((v) => !v)}
                className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                  vwapWatchEnabled
                    ? 'bg-gradient-to-r from-sky-600 to-cyan-600 text-white border-transparent shadow-xs font-black'
                    : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                }`}
                title="켜면 지금 보이는 후보 전체를 15초 주기로 계속 갱신해서, 재돌파 임박(아직 미돌파+간격 좁혀짐+거래량 선행) 또는 재돌파 완료 종목을 실시간으로 표시합니다"
              >
                <Zap className={`w-3.5 h-3.5 ${vwapWatchEnabled ? 'text-sky-200' : 'text-sky-600'}`} />
                <span>{vwapWatchEnabled ? 'VWAP 실시간 감시 중' : 'VWAP 실시간 감시'}</span>
                {vwapWatchEnabled && vwapWatchFetching && <RefreshCw className="w-3 h-3 animate-spin text-sky-100" />}
              </button>
              <button
                type="button"
                onClick={() => setPivotWatchEnabled((v) => !v)}
                className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                  pivotWatchEnabled
                    ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white border-transparent shadow-xs font-black'
                    : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                }`}
                title="켜면 전일 확정 피봇 저항선(R1·R2)을 뚫었다가 눌린 뒤 다시 그 선을 향해 올라오는 종목을 15초 주기로 계속 갱신해서 실시간으로 표시합니다"
              >
                <Target className={`w-3.5 h-3.5 ${pivotWatchEnabled ? 'text-violet-200' : 'text-violet-600'}`} />
                <span>{pivotWatchEnabled ? '피봇 재돌파 감시 중' : '피봇 재돌파 감시'}</span>
                {pivotWatchEnabled && pivotWatchFetching && <RefreshCw className="w-3 h-3 animate-spin text-violet-100" />}
              </button>
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
              {/* 🚨 [기능 재설계 - 사용자 요청: "토글 필터로 진행해줘"] 당일/2일연속/3일연속 어느 탭이든
                  위에 얹을 수 있는 "장마감 후보만" 토글 - 실측 백테스트로 검증한 역발상 점수(저가마감·
                  조용한 거래량·최근 눌림)로 재정렬 + 상위만 추린다. 예전엔 3일연속 전용 4번째 탭이었다. */}
              {!showDropouts && (
                <button
                  type="button"
                  onClick={() => setQuietAccumFilter((v) => !v)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                    quietAccumFilter
                      ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white border-transparent shadow-xs font-black'
                      : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                  title="지금 보고 있는 교집합 명단을, 저가마감·조용한 거래량·최근 눌림 기준으로 재정렬한 상위 후보만 추려서 봅니다 (실측 백테스트 검증)"
                >
                  <Target className={`w-3.5 h-3.5 ${quietAccumFilter ? 'text-emerald-200' : 'text-emerald-600'}`} />
                  <span>장마감 후보만</span>
                </button>
              )}
              {!showDropouts && (
                <button
                  type="button"
                  onClick={() => setVwapWatchEnabled((v) => !v)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                    vwapWatchEnabled
                      ? 'bg-gradient-to-r from-sky-600 to-cyan-600 text-white border-transparent shadow-xs font-black'
                      : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                  title="켜면 지금 보이는 후보 전체를 15초 주기로 계속 갱신해서, 재돌파 임박(아직 미돌파+간격 좁혀짐+거래량 선행) 또는 재돌파 완료 종목을 실시간으로 표시합니다"
                >
                  <Zap className={`w-3.5 h-3.5 ${vwapWatchEnabled ? 'text-sky-200' : 'text-sky-600'}`} />
                  <span>{vwapWatchEnabled ? 'VWAP 실시간 감시 중' : 'VWAP 실시간 감시'}</span>
                  {vwapWatchEnabled && vwapWatchFetching && <RefreshCw className="w-3 h-3 animate-spin text-sky-100" />}
                </button>
              )}
              {!showDropouts && (
                <button
                  type="button"
                  onClick={() => setPivotWatchEnabled((v) => !v)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                    pivotWatchEnabled
                      ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white border-transparent shadow-xs font-black'
                      : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                  title="켜면 전일 확정 피봇 저항선(R1·R2)을 뚫었다가 눌린 뒤 다시 그 선을 향해 올라오는 종목을 15초 주기로 계속 갱신해서 실시간으로 표시합니다"
                >
                  <Target className={`w-3.5 h-3.5 ${pivotWatchEnabled ? 'text-violet-200' : 'text-violet-600'}`} />
                  <span>{pivotWatchEnabled ? '피봇 재돌파 감시 중' : '피봇 재돌파 감시'}</span>
                  {pivotWatchEnabled && pivotWatchFetching && <RefreshCw className="w-3 h-3 animate-spin text-violet-100" />}
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
                                <RankingStockDetailChart symbol={d.symbol} />
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
                {quietAccumFilter
                  ? '장마감 후보만(저가마감·조용한 거래량·최근 눌림) 계산 중...'
                  : overlapMode === 'consecutive3d'
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
                ? (quietAccumFilter
                    ? '장마감 후보만 조건까지 만족하는 종목이 없습니다.'
                    : overlapMode !== 'daily'
                    ? `${overlapMode === 'consecutive2d' ? '2일' : '3일'} 이상 연속 수급이 2개 이상 주체에서 동시에 진행 중인 종목이 없습니다.`
                    : '조건에 부합하는 수급 교집합 종목 데이터가 없습니다.')
                : activeTab === 'watchlist'
                ? '등록된 관심종목이 없습니다. 종목 상세 화면(3분봉 탭 옆)의 "실시간" 버튼을 눌러 추가해주세요.'
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

                    {/* 🚨 [UI 정리 - 사용자 지적: "코스피, 코스닥, 신용뱃지는 종목 옆에 그대로 두고 다른
                        뱃지들을 옮겨줘. 헷갈려."] VWAP/피봇 재돌파 배지를 종목명 칸에서 분리해 전용 칸으로
                        옮긴다 - 감시를 켰을 때만 나타난다. reclaimWatchEnabled로 판단해 토글이 실제로
                        보이는 탭(급등주/수급교집합/장마감 후보군)에서만 뜨고 다른 탭엔 안 새어나간다. */}
                    {reclaimWatchEnabled && (
                      <th className="p-2.5 whitespace-nowrap min-w-[140px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">감시 신호</th>
                    )}

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
                    ) : activeTab === 'discovery' ? (
                      // 🚨 [기능 추가 - "발굴 장마감" 탭] 급등주 랭킹과 무관한 5가지 신규 지표 전용 컬럼.
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                        <th className="p-2.5 whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="상승 과정에서 누가 물량을 받았는지(장중 추정)">매집 주체</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="오늘 누적 거래대금 중 14시 이후 비중">오후 매수세</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="오늘 거래대금 ÷ 최근 20거래일 평균">거래대금 배율</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="당일 고가 등락률 대비 현재 등락률 하락폭(0에 가까울수록 고가권 유지)">눌림 저항</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="현재 등락률 - 소속 시장 지수 등락률">상대강도</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="5개 지표 백분위 평균 - 아직 실측 백테스트 전 잠정치">종합점수</th>
                      </>
                    ) : activeTab === 'precursor' ? (
                      // 🚨 [기능 추가 - "전조 장마감" 탭] 아직 크게 안 오른 상태에서 거래량만 조용히
                      // 늘고 있는지를 보는 4가지 지표 전용 컬럼.
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="최근 5거래일 누적 등락률 - 이미 급등한 종목은 후보에서 제외됨">최근5일 등락</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="오늘 거래대금 ÷ 최근 20거래일 평균">거래대금 배율</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="최근 3거래일 평균 거래량이 그 이전 3거래일보다 높은지">증가 추세</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="거래대금 배율 대비 가격변동 - 클수록 거래는 느는데 가격은 안 움직임">다이버전스</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="현재가 ÷ 당일 고가">고가유지</th>
                        <th className="p-2.5 text-center whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="4개 조건 배점 합계 - 아직 실측 백테스트 전 잠정치">종합점수</th>
                      </>
                    ) : activeTab === 'surging' || activeTab === 'postmarket' || activeTab === 'watchlist' ? (
                      activeTab === 'postmarket' ? (
                        // 🚨 [기능 축소 - 사용자 요청: "장마감 후보군 외국인, 기관 수급 얼마 들어갔는지 안보여도
                        // 되니까 그거 줄여서 가로 스크롤 삭제해"] 외국인/기관 수급 배지 2칸을 없애 테이블 총
                        // 너비를 줄인다(실측: 이 2칸이 포함된 상태에서 scrollWidth 1314px vs clientWidth
                        // 916px로 약 400px 가로 스크롤 발생 확인).
                        <>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">거래량</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">
                            <button
                              type="button"
                              onClick={handleOverlapAmountSortToggle}
                              className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                              title={sortField === 'amountEok' ? '다시 누르면 정상 순서로 되돌아갑니다' : '누르면 거래대금 높은 순으로 정렬합니다'}
                            >
                              거래대금
                              <ArrowUpDown className={`w-3 h-3 shrink-0 ${sortField === 'amountEok' ? 'opacity-100 text-amber-500' : 'opacity-60'}`} />
                            </button>
                          </th>
                          <th className="p-2.5 whitespace-nowrap max-w-[220px] sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">급등 상세 순위</th>
                        </>
                      ) : activeTab === 'surging' && surgingMode === 'overlap' ? (
                        <>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">등락률</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">거래량</th>
                          <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">
                            <button
                              type="button"
                              onClick={handleOverlapAmountSortToggle}
                              className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                              title={sortField === 'amountEok' ? '다시 누르면 정상 순서로 되돌아갑니다' : '누르면 거래대금 높은 순으로 정렬합니다'}
                            >
                              거래대금
                              <ArrowUpDown className={`w-3 h-3 shrink-0 ${sortField === 'amountEok' ? 'opacity-100 text-amber-500' : 'opacity-60'}`} />
                            </button>
                          </th>
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
                        <td className="p-2.5 text-center font-bold">
                          <div className="flex flex-row items-center justify-center gap-1 flex-wrap">
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
                            {/* 🚨 [UI 통일 - 사용자 요청] "신용가능만" 필터의 (전체 N위) 표기와 동일한
                                자리·스타일로 통일한다 - VWAP 재돌파 배지 안에 따로 표기하지 않는다. */}
                            {(vwapWatchActive || pivotWatchActive) && (item as any).vwapOriginalRank !== undefined && (
                              <span className="text-[9px] text-slate-400 dark:text-slate-500 font-sans font-normal whitespace-nowrap shrink-0">
                                (전체 {(item as any).vwapOriginalRank}위)
                              </span>
                            )}
                          </div>
                        </td>

                        {/* 종목명 */}
                        {/* 🚨 [버그 수정 - 사용자 지적: "가로스크롤이 생겨서 좀 불편하네"] VWAP/피봇 감시를
                            켜면 신용 아이콘 + 배지 2개 + "(전체 N위)" 텍스트까지 이 셀 한 줄에 전부 whitespace-
                            nowrap으로 쌓여서 테이블 전체가 옆으로 밀려났다. 종목명 칸은 폭을 억지로 넓히는
                            대신 내용이 넘치면 다음 줄로 흘러가게(flex-wrap) 바꾼다 - 종목명·배지 모두 두 줄
                            까지는 괜찮다는 사용자 확인. */}
                        <td className="p-2.5 font-sans font-bold min-w-[110px] max-w-[220px]">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition text-xs">
                              {getStockName(item.symbol, item.name)}
                            </span>
                            {getStockName(item.symbol, item.name) !== item.symbol && (
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">
                                {item.symbol}
                              </span>
                            )}
                            {/* 🎯 [기능 추가 - 사용자 요청: "꼭 관심종목 버튼을 눌러야만 하는거야?"] 어느
                                탭에서든 이 별 아이콘 하나로 관심종목(ws_watchlist) 추가/제거가 바로 된다 -
                                종목 상세 화면까지 안 들어가도 됨. */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleWsWatchlistSymbol(item.symbol, getStockName(item.symbol, item.name));
                              }}
                              disabled={wsWatchlistTogglingSymbol === item.symbol}
                              title={wsWatchlistSet.has(item.symbol) ? '관심종목에서 제거' : '관심종목에 추가 (실시간 웹소켓 감시)'}
                              className={`shrink-0 cursor-pointer disabled:opacity-40 ${
                                wsWatchlistSet.has(item.symbol) ? 'text-amber-500' : 'text-slate-300 dark:text-slate-600 hover:text-amber-400'
                              }`}
                            >
                              <Star className="w-3.5 h-3.5" fill={wsWatchlistSet.has(item.symbol) ? 'currentColor' : 'none'} />
                            </button>
                            {/* 🎯 [기능 추가 - 사용자 요청: "피봇, vwap 둘다 옆에 신용 가능한지... 로고 붙여줘.
                                얘네는 종목이 별로 없어서 따로 신용가능 토글을 쓰기가 애매해"] VWAP/피봇 재돌파
                                배지가 실제로 뜬 행에만(전체 목록 대상 별도 필터 토글 없이) 기존 3-상태 아이콘을
                                그대로 붙인다(수칙 1-6, 새 로직 아님 - MobileStockDetailChart.tsx가 쓰던 매핑
                                재사용). */}
                            {(() => {
                              const v = vwapWatchEnabled ? vwapReclaimMap?.get(item.symbol) : undefined;
                              const p = pivotWatchEnabled ? pivotReclaimMap?.get(item.symbol) : undefined;
                              const hasWatchBadge = !!(
                                v?.approaching || v?.reclaimed || v?.hadPriorReclaim ||
                                p?.r1.approaching || p?.r1.reclaimed || p?.r1.hadPriorBreak ||
                                p?.r2.approaching || p?.r2.reclaimed || p?.r2.hadPriorBreak
                              );
                              if (!hasWatchBadge) return null;
                              return <CreditShieldIcon isCreditAvailable={item.isCreditAvailable} />;
                            })()}
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

                        {/* 🚨 [UI 정리 - 사용자 지적: "코스피, 코스닥, 신용뱃지는 종목 옆에 그대로 두고
                            다른 뱃지들을 옮겨줘. 헷갈려."] VWAP/피봇 재돌파 배지 전용 칸 - 종목명 칸과
                            섞여 있으면 어느 배지가 종목 정보고 어느 게 감시 신호인지 헷갈린다는 지적을
                            반영해 분리했다. */}
                        {reclaimWatchEnabled && (
                          <td className="p-2.5 font-sans min-w-[140px]">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {/* 🚨 [기능 보강 - 사용자 지적: "이미 재돌파 하고나면 내가 또 못사잖아"] 아직
                                  안 뚫었지만 곧 뚫을 것 같은 "임박"(선행, 액션 가능)과 이미 다 끝난 "완료"
                                  (후행, 참고용)를 색으로 구분한다 - 임박이 실제로 사려는 시점에 더 유용하다. */}
                              {/* 🚨 [기능 추가 - 사용자 지적: "성호전자도 계속 재돌파했다가 재돌파임박
                                  했다가... 꾸준하게 있다가 재돌파하는 종목들을 보고싶은데"] crossCount가
                                  기준(4회, 실측 90 백분위수) 이상이면 임박/완료 대신 "잦은 등락"으로 표시해
                                  VWAP 근처 노이즈성 왕복과 진짜 방향성 돌파를 구분한다. */}
                              {(() => {
                                const v = vwapWatchEnabled ? vwapReclaimMap?.get(item.symbol) : undefined;
                                if (!v) return null;
                                const isFrequentFlip = (v.approaching || v.reclaimed) && v.crossCount >= FREQUENT_FLIP_CROSS_COUNT;
                                if (isFrequentFlip) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-orange-50 dark:bg-orange-950/40 text-orange-500 dark:text-orange-400 border-orange-200 dark:border-orange-800/50 flex items-center gap-0.5"
                                      title={`오늘 VWAP를 ${v.crossCount}번 넘나들었습니다 - 방향성 돌파가 아니라 VWAP 근처에서 계속 왕복하는 노이즈성 신호일 가능성이 높습니다(참고용, 신뢰도 낮음)`}
                                    >
                                      <Zap className="w-2.5 h-2.5" />
                                      VWAP 잦은 등락({v.crossCount}회)
                                    </span>
                                  );
                                }
                                if (v.approaching) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 flex items-center gap-0.5 animate-pulse"
                                      title={
                                        v.hadPriorReclaim
                                          ? '오늘 이미 한 번 재돌파에 성공했다가 다시 눌린 뒤, 재차 VWAP에 근접하고 있습니다'
                                          : '아직 VWAP를 뚫진 않았지만 간격이 좁혀지고 거래량이 먼저 붙기 시작했습니다'
                                      }
                                    >
                                      <Zap className="w-2.5 h-2.5" />
                                      재돌파 임박{v.hadPriorReclaim ? '(2차 시도)' : ''}
                                    </span>
                                  );
                                }
                                if (v.reclaimed) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-800/60 flex items-center gap-0.5"
                                      title={
                                        v.volSurge
                                          ? 'VWAP 재돌파 + 거래량 재증가가 이미 확인됐습니다(참고용, 진입 시점은 이미 지났을 수 있음)'
                                          : 'VWAP 재돌파는 확인됐지만, 돌파 시점 거래량 증가는 확인되지 않았습니다(참고용)'
                                      }
                                    >
                                      <Zap className="w-2.5 h-2.5" />
                                      VWAP재돌파(완료){v.volSurge ? '' : '·거래량 미확인'}
                                    </span>
                                  );
                                }
                                return null;
                              })()}
                              {/* 🎯 [기능 추가 - 사용자 요청: "남겨두자. 그리고 그걸 순위 밑으로두자"] 지금은
                                  임박도 완료도 아니지만(다시 VWAP 아래로 내려감) 오늘 한 번은 뚫었던 이력-
                                  흐린 참고용 배지로만 남기고 정렬 순위는 맨 아래로 내려간다. */}
                              {vwapWatchEnabled && !vwapReclaimMap?.get(item.symbol)?.approaching && !vwapReclaimMap?.get(item.symbol)?.reclaimed && vwapReclaimMap?.get(item.symbol)?.hadPriorReclaim && (
                                <span
                                  className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-slate-50 dark:bg-slate-900/60 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700/60 flex items-center gap-0.5 opacity-70"
                                  title="오늘 이미 한 번 VWAP를 뚫었다가 다시 아래로 내려간 이력이 있습니다(현재는 재접근 신호 없음, 대기 중)"
                                >
                                  <Zap className="w-2.5 h-2.5" />
                                  VWAP 이전이력(대기)
                                </span>
                              )}
                              {/* 🎯 [기능 추가 - 사용자 요청: "R2까지 안가고 R1까지 뚫었어도... 다시 올라올거
                                  같은 반등"] R2가 걸려있으면 R2를(더 강한 신호), 아니면 R1을 표시한다. */}
                              {pivotWatchEnabled && (() => {
                                const p = pivotReclaimMap?.get(item.symbol);
                                if (!p) return null;
                                const level: 'R2' | 'R1' | null =
                                  p.r2.approaching || p.r2.reclaimed ? 'R2'
                                  : p.r1.approaching || p.r1.reclaimed ? 'R1'
                                  : p.r2.hadPriorBreak ? 'R2'
                                  : p.r1.hadPriorBreak ? 'R1' : null;
                                if (!level) return null;
                                const sig = level === 'R2' ? p.r2 : p.r1;
                                if (sig.approaching) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-violet-50 dark:bg-violet-950/60 text-violet-600 dark:text-violet-400 border-violet-200 dark:border-violet-800/60 flex items-center gap-0.5 animate-pulse"
                                      title={`${level}을(를) 뚫었다가 눌린 뒤, 다시 ${level}을(를) 향해 간격이 좁혀지고 거래량이 붙기 시작했습니다`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      {level} 재돌파 임박
                                    </span>
                                  );
                                }
                                if (sig.reclaimed) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/60 flex items-center gap-0.5"
                                      title={`${level}을(를) 뚫었다가 눌린 뒤 다시 위로 올라왔습니다(참고용)${sig.volSurge ? '' : ' - 거래량 증가는 확인되지 않았습니다'}`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      {level}재돌파(완료){sig.volSurge ? '' : '·거래량 미확인'}
                                    </span>
                                  );
                                }
                                if (sig.hadPriorBreak) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-slate-50 dark:bg-slate-900/60 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700/60 flex items-center gap-0.5 opacity-70"
                                      title={`오늘 이미 ${level}을(를) 뚫었다가 다시 아래로 내려간 이력이 있습니다(현재는 재접근 신호 없음, 대기 중)`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      {level} 이전이력(대기)
                                    </span>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          </td>
                        )}

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
                              {/* 🚨 [기능 재설계 - "장마감 후보만" 토글] 백테스트로 검증한 역발상 지표 값을
                                  그대로 노출한다 - 종가위치·거래량배율·5일누적수익률 전부 "낮을수록" 다음날
                                  수익률이 좋았다(kisApi.ts의 applyQuietAccumulationFilter 주석 참고). 옛
                                  "변동폭 축소·고가마감이 좋다" 가정과 정반대라 문구도 반대로 바꿨다. */}
                              {quietAccumFilter && item.closePositionPct !== undefined && (
                                <span
                                  className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap shrink-0 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/60"
                                  title="저가~고가 구간 내 종가 위치(낮을수록 저가마감·유리) · 최근 5거래일 평균 대비 오늘 거래량(낮을수록 조용함·유리)"
                                >
                                  종가위치 {item.closePositionPct}% · 거래량 {item.volRatioPct}%
                                </span>
                              )}
                              {quietAccumFilter && item.cum5dReturnPct !== undefined && (
                                <span
                                  className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap shrink-0 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800/60"
                                  title="최근 5거래일 누적수익률(낮을수록·눌려있을수록 유리)"
                                >
                                  5일누적 {item.cum5dReturnPct >= 0 ? '+' : ''}{item.cum5dReturnPct}%
                                </span>
                              )}
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
                        ) : activeTab === 'discovery' ? (
                          <>
                            <td className="p-2.5 text-right font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {item.currentPrice.toLocaleString()} 원
                            </td>
                            <td className="p-2.5 text-right font-bold font-mono whitespace-nowrap">
                              <span className={item.changeRate >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                {item.changeRate >= 0 ? '+' : ''}{item.changeRate.toFixed(2)}%
                              </span>
                            </td>
                            <td className="p-2.5 whitespace-nowrap">
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-md font-bold border ${
                                  item.absorptionDirection === 'both'
                                    ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white border-transparent'
                                    : item.absorptionDirection === 'foreign' || item.absorptionDirection === 'organ'
                                    ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                                }`}
                              >
                                {item.absorptionBadge || '데이터 없음'}
                              </span>
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.afternoonVolumeRatioPct != null ? `${item.afternoonVolumeRatioPct.toFixed(1)}%` : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.volumeSurgeRatio != null ? `${item.volumeSurgeRatio.toFixed(2)}배` : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono whitespace-nowrap">
                              {item.pullbackFromHighPct != null ? (
                                <span className={item.pullbackFromHighPct <= 1 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'}>
                                  -{item.pullbackFromHighPct.toFixed(2)}%p
                                </span>
                              ) : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono whitespace-nowrap">
                              {item.relativeStrengthPct != null ? (
                                <span className={item.relativeStrengthPct >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                  {item.relativeStrengthPct >= 0 ? '+' : ''}{item.relativeStrengthPct.toFixed(2)}%p
                                </span>
                              ) : '-'}
                            </td>
                            <td className="p-2.5 text-center font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {item.discoveryScore != null ? item.discoveryScore.toFixed(1) : '-'}
                            </td>
                          </>
                        ) : activeTab === 'precursor' ? (
                          <>
                            <td className="p-2.5 text-right font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {item.currentPrice.toLocaleString()} 원
                            </td>
                            <td className="p-2.5 text-right font-bold font-mono whitespace-nowrap">
                              <span className={item.changeRate >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                {item.changeRate >= 0 ? '+' : ''}{item.changeRate.toFixed(2)}%
                              </span>
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.recentReturnPct != null ? (
                                <span className={item.recentReturnPct >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                  {item.recentReturnPct >= 0 ? '+' : ''}{item.recentReturnPct.toFixed(2)}%
                                </span>
                              ) : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.volumeSurgeRatio != null ? `${item.volumeSurgeRatio.toFixed(2)}배` : '-'}
                            </td>
                            <td className="p-2.5 text-center whitespace-nowrap">
                              {item.volumeTrendIncreasing != null ? (
                                item.volumeTrendIncreasing
                                  ? <span className="text-[10px] px-2 py-0.5 rounded-md font-bold bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/60">증가 ↑</span>
                                  : <span className="text-[10px] text-slate-400 dark:text-slate-500">-</span>
                              ) : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.priceVolumeDivergence != null ? item.priceVolumeDivergence.toFixed(2) : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.closeToHighRatioPct != null ? `${item.closeToHighRatioPct.toFixed(1)}%` : '-'}
                            </td>
                            <td className="p-2.5 text-center font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {item.precursorScore != null ? item.precursorScore.toFixed(1) : '-'}
                            </td>
                          </>
                        ) : activeTab === 'surging' || activeTab === 'postmarket' || activeTab === 'watchlist' ? (
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

                            {activeTab === 'postmarket' ? (
                              // 🚨 [기능 축소 - 사용자 요청: "외국인, 기관 수급 얼마 들어갔는지 안보여도 되니까
                              // 그거 줄여서 가로 스크롤 삭제해"] 급등 교집합 뱃지만 남기고 외국인/기관 수급
                              // 2칸을 제거한다(위 헤더와 동일하게 맞춤). 이 뱃지 문구 자체가 "등락률 N위 ·
                              // 거래량 N위 · ... · 기관매수우위"처럼 길어서 whitespace-nowrap이면 그 한 줄만으로
                              // 가로 스크롤이 남는다 - 줄바꿈 허용(max-w + normal)으로 전환해 폭을 눌러 담는다.
                              <td className="p-2.5 max-w-[220px]">
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-md font-bold inline-flex items-center gap-1 whitespace-normal leading-snug ${
                                    item.overlapCount && item.overlapCount >= 3
                                      ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white shadow-xs'
                                      : 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700/50'
                                  }`}
                                >
                                  {item.surgingBadge || `${item.overlapCount || 2}개 일치`}
                                </span>
                              </td>
                            ) : activeTab === 'surging' && surgingMode === 'overlap' ? (
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
                                <RankingStockDetailChart symbol={item.symbol} />
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
