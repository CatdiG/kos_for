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
import { fetchReclaimWatchSignals, ReclaimWatchSignal, computeReclaimFreshnessInfo } from '@/lib/vwapReclaimClient';
import { VwapReclaimSignal, PivotReclaimSignal } from '@/lib/types';
import { getSupabaseBrowserClient } from '@/lib/supabaseBrowserClient';
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
  // 🚨 [기본값 변경 - 사용자 요청: "급등주탭이 눌리면 맨 앞에 있는 급등주 교집합이 제일 먼저 떠야지",
  // 2026-09-23] activeTab 초기값이 이미 'surging'이라(위 73번 줄) 첫 로드 시 handleTabChange를 안 거치므로
  // 여기 기본값도 같이 맞춰야 한다.
  const [surgingMode, setSurgingMode] = useState<SurgingMode>('overlap');
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
      // 🚨 [기능 재설계 - 사용자 지적: "관심종목 웹소캣으로 실시간 된다는거 아니였어? 안되는데"] 원래
      // "실시간"이라고 주석에 적어놓고 실제로는 30초 REST 폴링만 하고 있었다(제 실수 인정) - 아래
      // realtime_quotes 구독(useEffect)이 진짜 push를 담당하고, 이 30초는 그 안전망(연결 끊김/재시작/
      // 41개 초과분 대비)으로만 남긴다.
      if (activeTab === 'watchlist') return 30 * 1000;
      return false;
    },
  });

  // 🎯 [기능 추가 - 사용자 요청: "장마감 후보들은 언제 업데이트 되는거야? 마지막 업데이트 시점을 각자
  // 토글 옆에 표시해줘, 기존에 쓰던 기준 표기 있으면 그거 쓰고"] 발굴/전조는 이미 lastBatchTime
  // ("9/18 14:30 기준" 형식, 수칙 1-5 기준일 표기 관례 그대로) API 응답에 포함돼 있었다 - 지금까지
  // 화면에 안 보여줬을 뿐이다(새 포맷 함수 안 만듦). 지금 보고 있는 서브탭이 아니어도 토글 옆에 바로
  // 보이게 하려고, 위 메인 쿼리와 완전히 동일한 요청(discovery/precursor)을 "장마감 후보군" 그룹이
  // 열려있는 동안 항상 캐시해둔다 - queryKey가 메인 쿼리와 정확히 같아서(react-query가 키로 캐시를
  // 공유) 그 탭을 실제로 클릭해도 중복 호출되지 않는다. 이 두 엔드포인트는 Supabase 스냅샷을 읽기만
  // 해서 KIS 호출이 없다(수칙 2-6과 동일 취지 - 가벼운 프리페치만 허용).
  const { data: discoveryBatchData } = useQuery<InvestorRankingResponse>({
    queryKey: ['discovery', market],
    queryFn: async () => {
      const res = await fetch(`/api/stock/discovery?market=${market}`);
      if (!res.ok) throw new Error('발굴 장마감 데이터를 가져오는 중 오류가 발생했습니다.');
      return res.json();
    },
    enabled: isPostMarketGroup,
    staleTime: 30 * 1000,
  });
  const { data: precursorBatchData } = useQuery<InvestorRankingResponse>({
    queryKey: ['precursor', market],
    queryFn: async () => {
      const res = await fetch(`/api/stock/precursor?market=${market}`);
      if (!res.ok) throw new Error('전조 장마감 데이터를 가져오는 중 오류가 발생했습니다.');
      return res.json();
    },
    enabled: isPostMarketGroup,
    staleTime: 30 * 1000,
  });
  // "급등"(postmarket)은 KIS 라이브 호출이라 위 둘과 달리 미리 당겨오지 않는다(수칙 1-3 - 안 쓸 수도
  // 있는 호출을 미리 만들지 않음) - 실제로 그 토글을 눌러 메인 쿼리가 이 탭을 가져온 뒤에만 라벨이
  // 뜬다(정직하게 "아직 조회 안 함"과 "언제 조회했음"을 구분). live 계산이라 lastBatchTime이 없을 수
  // 있어 updatedAt(조회 시각)을 폴백으로 쓴다.
  const postmarketBatchData = activeTab === 'postmarket' ? data : (queryClient.getQueryData(['surging', 'postmarket', market, null]) as InvestorRankingResponse | undefined);
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

  // 🎯 [기능 추가 - 사용자 요청: "그거 실행하자"] Supabase Realtime으로 realtime_quotes 테이블 변경을
  // 직접 구독한다 - 오라클 클라우드의 ws-bridge가 KIS 웹소켓 틱마다 이 표에 upsert하면(2초 주기,
  // ws-bridge/index.mjs 참고) Postgres 변경 스트림이 새 웹소켓 서버 없이 브라우저로 바로 push된다.
  // react-query 캐시를 직접 patch해서 다음 30초 안전망 폴링을 기다리지 않고 화면에 즉시 반영한다.
  useEffect(() => {
    if (activeTab !== 'watchlist') return;
    const client = getSupabaseBrowserClient();
    if (!client) return;

    const queryKey = ['surging', 'watchlist', market, surgingMode === 'overlap' ? overlapMinCount : null];
    const channel = client
      .channel('watchlist-realtime-quotes')
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
  }, [activeTab, market, surgingMode, overlapMinCount, queryClient]);

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
  // 🚨 [버그 수정 - 사용자 지적: "급등주 다른 토글은 실시간 감시 되는데 급등주 교집합은 안되잖냐.. 다
  // 되게 해줘야지"] 직전에 급등주 교집합을 감시 대상에서 통째로 뺐었는데, 실제로는 등락률/거래량/
  // 거래대금과 똑같이 감시가 적용돼야 했다 - 예전 요청("급등주 교집합 옆에 실시간 감시 토글을 또
  // 만들라고")은 버튼 배치(교집합 pill 옆에 병합 토글을 둔다)에 대한 것이었지, 교집합 목록을 감시에서
  // 제외하라는 뜻이 아니었다. 제외 로직을 걷어내고 다른 서브모드와 동일하게 취급한다.
  const reclaimWatchEnabled = watchTogglesVisible && (vwapWatchEnabled || pivotWatchEnabled);
  const { data: reclaimWatchMap, isFetching: reclaimWatchFetching, refetch: refetchReclaimWatch } = useQuery<Map<string, ReclaimWatchSignal>>({
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
  // 🚨 [버그 수정 - 사용자 지적: "거래대금 하면 원래 순위가 몇이었는지도 알려줘야해"] "거래대금" 버튼을
  // 누르면 위 3번 정렬 단계에서 item.rank 필드 자체는 손대지 않은 채 배열 순서만 amountEok 기준으로
  // 바뀐다 - 즉 이 시점의 item.rank는 아직 "정상"(교집합 등 원래 정렬 기준) 순위값이다. 여기서
  // rank/overallRank를 1,2,3...으로 덮어쓰기 직전에 그 값을 originalRank로 스냅샷해둔다(수칙 1-6,
  // vwapOriginalRank와 동일한 관례).
  fullList = fullList.map((item, idx) => ({
    ...item,
    originalRank: item.rank,
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
  // 🎯 [기능 재설계 - 사용자 요청: "재돌파 임박 → 재돌파 확인(방금 발생) → 돌파 완료(유지 중) → 완료 후
  // 5분 경과(오래된 이벤트) 순으로 정렬하고, 이런 신호의 신선도를 넣어"] 예전엔 approaching/reclaimed가
  // 아니면 통째로 필터링해서 hadPriorReclaim/hadPriorBreak만 있는 종목이 화면에서 완전히 사라졌다(=
  // "떴다 사라진다"는 불만의 원인) - 신선도 기반 우선순위 점수 하나로 환산해서, 더 최근/액션 가능한
  // 순서대로 위에서 아래로 정렬한다: 5=임박 > 4=방금 재돌파 확인(30초 미만) > 3=돌파 완료(유지 중,
  // 30초~5분) > 2=완료(5분+ 경과, 오래된 이벤트) > 1.5=잦은 등락(4회+, 아직 신선함) > 1=이전 이력만
  // (지금은 잠잠함, 대기 중) > 0=오늘 신호 이력 전혀 없음(제외). VWAP·피봇 둘 다 켜져 있으면 더 강한
  // 신호 쪽 점수를 취한다. computeReclaimFreshnessInfo는 desktop/mobile 공용 함수(수칙 1-6).
  // 🚨 [기능 재설계 - 사용자 지적: "번개로고가 vwap인거 아니야? 그게 나오지 말고 피봇에 녹아들어서
  // 점수를 내야하는거라고" - "R1/R2 = 주된 돌파 레벨, VWAP = 보조 지표, R1/R2 재돌파 + 거래량 증가 +
  // 유지를 메인으로 보고 VWAP도 같이 회복하고 있으면 가산점 정도로 처리하자"] 예전엔 `vPriority >=
  // pPriority`로 VWAP 혼자 튀어도 R1/R2보다 우선순위가 높아질 수 있었다(대우건설이 이 경로로 떴을
  // 가능성이 높다 - 사용자 실측: "저거보고 대우건설 샀다가 떡락중이다"). 이제 정렬 우선순위(priority)는
  // R1/R2만으로 정하고, VWAP는 그 안에서 완전히 동점(같은 priority, 같은 elapsedMs)일 때만 순서를
  // 살짝 미는 타이브레이커로 쓴다 - 화면에 별도 배지/숫자로 드러나지 않는다(사용자 확정: "그게 나오지
  // 말고 피봇에 녹아들어서").
  const getWatchPriority = (item: RankingItem): { priority: number; elapsedMs: number; vwapBonus: boolean } => {
    const p = pivotWatchActive ? pivotReclaimMap!.get(item.symbol) : undefined;
    // 🚨 [버그 수정 - 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"] holding(처음 뚫은 뒤 한
    // 번도 안 내려가고 계속 위)도 레벨 선택에 포함시킨다 - 예전엔 hadPriorBreak(재돌파 이력)만 봐서,
    // 처음 뚫고 계속 유지 중인 R2가 있어도 못 보고 더 낮은 R1을 대신 골랐다.
    const pLevel = p && (p.r2.approaching || p.r2.reclaimed || p.r2.holding || p.r2.hadPriorBreak) ? p.r2 : p?.r1;
    let pPriority = 0;
    let pElapsed = 0;
    if (pLevel?.approaching) {
      pPriority = 5;
    } else if ((pLevel?.reclaimed || pLevel?.holding) && pLevel.elapsedMs != null) {
      // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?"] 피봇(R1/R2)도 이제
      // crossCount를 추적하므로(watch_signal_state 테이블 확장, 수칙 1-6) VWAP과 동일하게 잦은 등락
      // 등급(FREQUENT_FLIP_CROSS_COUNT=4 이상)이 적용된다.
      const info = computeReclaimFreshnessInfo(pLevel.elapsedMs, pLevel.crossCount);
      pPriority = info.priority;
      pElapsed = pLevel.elapsedMs;
    } else if (pLevel?.hadPriorBreak) {
      pPriority = 1;
    }

    // 🚨 [재설계 - 사용자 지적: "저렇게 박스를 하는게 내가 3분봉 보고 매매에 대해 도움이 되나? 박스권
    // 하락, 박스권 돌파 이런걸 원했던건데... 순위표 배지로"] R1/R2와 무관한 순수 가격 흐름 기반 신호
    // (priceLeg)도 정렬에 반영한다 - R1/R2 신호(pPriority)와 서로 다른 근거로 계산되므로 더 높은(더
    // 볼 가치 있는) 쪽을 그대로 쓴다(max). 'up'(박스권재돌파)은 approaching과 비슷한 급의 진입 신호라
    // 그 바로 아래, 'down'(R2돌파 후 하락)은 위험 신호라 hadPriorBreak보다는 위, 'box'(박스권 유지)는
    // 예전 inBox와 동일한 자리(2)를 그대로 쓴다 - 아직 실측 백테스트로 검증한 등급은 아니다(수칙 1-7).
    const priceLegPriority = p?.priceLeg?.type === 'up' ? 4 : p?.priceLeg?.type === 'down' ? 3 : p?.priceLeg?.type === 'box' ? 2 : 0;
    pPriority = Math.max(pPriority, priceLegPriority);

    const v = vwapWatchActive ? vwapReclaimMap!.get(item.symbol) : undefined;
    const vwapBonus = !!(v?.reclaimed || v?.approaching); // "VWAP도 같이 회복 중" - 가산점(동점 타이브레이커)만, priority 자체엔 안 섞는다.

    return { priority: pPriority, elapsedMs: pElapsed, vwapBonus };
  };
  if (pivotWatchActive) {
    displayList = displayList
      .map((item) => ({ item, ...getWatchPriority(item) }))
      .filter(({ priority }) => priority > 0)
      // 🚨 [버그 수정 - 사용자 지적: "실시간 감시했을때 거래대금 버튼 안먹힌다"] 예전엔 sortField가
      // 무엇이든 무조건 priority(재돌파 신선도) 기준으로만 재정렬해서, "거래대금" 버튼을 눌러 sortField를
      // 'amountEok'로 바꿔도 화면 순서가 그대로 priority 순이었다(3번 정렬 단계의 결과가 여기서 통째로
      // 덮어써짐). 실시간 감시로 걸러진(priority>0) 종목 안에서도 거래대금 버튼을 누르면 거래대금 순으로
      // 보여야 하므로, sortField==='amountEok'일 때는 priority 정렬 대신 거래대금 내림차순을 쓴다.
      .sort((a, b) => {
        if (sortField === 'amountEok') {
          return (b.item.amountEok || 0) - (a.item.amountEok || 0);
        }
        return b.priority - a.priority || (Number(b.vwapBonus) - Number(a.vwapBonus)) || a.elapsedMs - b.elapsedMs || a.item.rank - b.item.rank;
      })
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
      // 🚨 [기능 변경 - 사용자 요청: "급등주탭이 눌리면 맨 앞에 있는 급등주 교집합이 제일 먼저 떠야지",
      // 2026-09-23] 서브모드 버튼 순서를 교집합-맨앞으로 바꿨으니(수칙 1-6 일관성), 급등주 탭에 새로
      // 들어올 때도 기본값을 그 순서와 맞춘다.
      if (newTab === 'surging') {
        setSurgingMode('overlap');
      }
      // 🚨 [기능 변경 - 사용자 요청: "다른탭으로 이동할때 실시간 감시 토글버튼은 꺼줘", 2026-09-23] 예전엔
      // 탭을 옮겨도 감시 모드가 유지되게 일부러 안 껐는데(아래 949번 줄 주석 참고), 이번 요청으로 반대로
      // 바꾼다 - 탭 전환 시 무조건 끈다.
      setVwapWatchEnabled(false);
      setPivotWatchEnabled(false);
      // 급등주 교집합 "거래대금" 정렬을 켜둔 채로 다른 탭으로 넘어가면 그 탭엔 amountEok가 없거나
      // 의미가 달라서 정렬이 이상하게 보일 수 있어 정상 순서로 되돌린다.
      if (sortField === 'amountEok') {
        setSortField('netBuyAmt');
        setSortAsc(false);
      }
    }
  };

  // 🎯 [기능 추가 - 사용자 요청: "토글들 계속 껏다켰다 하기 너무 힘든데"] VWAP 실시간 감시·피봇 재돌파
  // 감시 - 예전엔 버튼 2개를 따로 켜야 했는데 항상 같이 쓰는 패턴이라 하나로 합쳤다. 지금 보고 있는
  // 서브모드가 무엇이든(급등주 교집합 포함) 그대로 적용된다(사용자 확정: "급등주 다른 토글은 실시간
  // 감시 되는데 급등주 교집합은 안되잖냐.. 다 되게 해줘야지").
  const handleRealtimeWatchToggle = () => {
    const turningOn = !vwapWatchEnabled; // vwapWatchEnabled/pivotWatchEnabled는 이 핸들러로만 바뀌므로 항상 서로 동기화되어 있다.
    setVwapWatchEnabled(turningOn);
    setPivotWatchEnabled(turningOn);
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
  // 🚨 [기능 변경 - 사용자 요청: "다른탭으로 이동할때 실시간 감시 토글버튼은 꺼줘", 2026-09-23] 예전엔
  // vwapWatchEnabled를 탭 전환에도 유지했었는데(감시 모드가 계속 켜진 채로 새 탭 목록으로 자동 전환),
  // 이번 요청으로 정반대로 바뀌었다 - 이제 handleTabChange에서 탭이 바뀔 때마다 명시적으로 끈다.
  useEffect(() => {
    setExpandedSymbols({});
  }, [activeTab, surgingMode, market, direction, period, overlapMode, overlapLimit, weights, creditOnly, entryReadyOnly, sortField, sortAsc, quietAccumFilter]);

  // 🚨 [순서 변경 - 사용자 요청: "급등주 뒤에 관심종목, 그 뒤에 장마감 후보군", 2026-09-23]
  const tabs: { id: RankingType; label: string; icon: any; isRealtime: boolean; badge?: string }[] = [
    { id: 'surging', label: '급등주', icon: Rocket, isRealtime: true, badge: 'LIVE' },
    // 🚨 [기능 추가 - 사용자 요청: "관심종목으로 누른 종목들 관심종목으로 따로 빼줘. 단타종합랭킹이랑
    // 장마감 후보군 사이에"] 종목 상세(RankingStockDetailChart)의 "실시간" 토글로 등록한 관심종목
    // (ws_watchlist, 오라클 웹소켓 브릿지 구독 대상과 동일 목록)의 현재가를 보여주는 탭.
    { id: 'watchlist', label: '관심종목', icon: Star, isRealtime: true },
    // 🚨 [기능 통합 - 사용자 요청: "장마감 탭들을 장마감 후보군 탭으로 합쳐서 각자 토글로"] 원래 급등
    // 장마감(postmarket)·발굴 장마감(discovery)·전조 장마감(precursor) 3개 탭이었는데, 화면엔 이 하나로
    // 합치고 내부 토글(급등/발굴/전조)로 전환한다 - isPostMarketGroup/POSTMARKET_SUBMODES 참고.
    // id는 postmarket을 대표값으로 쓴다(처음 클릭 시 기본 서브모드).
    { id: 'postmarket', label: '장마감 후보군', icon: Target, isRealtime: false, badge: 'NEW' },
    { id: 'comprehensive', label: '단타 종합랭킹', icon: Trophy, isRealtime: true, badge: 'SCORE' },
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
              {/* 🚨 [버그 수정 - 사용자 지적: "왜 새로고침 토글 안통해. 아무것도 안뜰때 내가 새로고침해서라도
                  뜨게 하려했는데"] 이 버튼은 메인 랭킹 쿼리(refetch)만 다시 불러왔다 - 실시간 감시(VWAP/
                  피봇 재돌파) 신호는 완전히 별도의 쿼리(reclaimWatchMap, 15초 자동 폴링)라서 눌러도 전혀
                  반응하지 않았다. 감시가 켜져 있을 때는 그 쿼리도 함께 즉시 refetch한다. */}
              <button
                type="button"
                onClick={() => {
                  refetch();
                  if (reclaimWatchEnabled) refetchReclaimWatch();
                }}
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
              {/* 🚨 [순서 변경 - 사용자 요청: "급등주 교집합을 제일 앞으로", 2026-09-23] 실시간 감시
                  토글과 겹침기준 토글(아래 surgingMode==='overlap' 블록)은 그대로 두고, 서브모드 pill
                  4개 중 급등주 교집합만 맨 앞으로 옮긴다. */}
              <div className="bg-red-50 dark:bg-red-950/40 p-1 rounded-xl flex items-center text-xs font-medium border border-red-200 dark:border-red-800/40 max-w-full overflow-hidden gap-0.5 shrink-0">
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
                {/* 🎯 [기능 추가 - 사용자 요청: "급등주 다른 토글은 실시간 감시 되는데 급등주 교집합은
                    안되잖냐.. 다 되게 해줘야지", "토글들 계속 껏다켰다 하기 너무 힘든데"] VWAP·피봇 감시
                    버튼 2개를 하나로 합쳐 같은 줄(교집합 바로 옆)에 둔다 - 급등주 교집합을 포함한 모든
                    서브모드에 동일하게 적용된다. */}
                <button
                  type="button"
                  onClick={handleRealtimeWatchToggle}
                  className={`px-2.5 py-1 rounded-lg transition whitespace-nowrap cursor-pointer text-xs font-bold flex items-center gap-1 shrink-0 ${
                    vwapWatchEnabled
                      ? 'bg-gradient-to-r from-sky-600 to-violet-600 text-white shadow-xs font-black'
                      : 'text-red-700 dark:text-red-300 hover:text-red-900'
                  }`}
                  title="켜면 VWAP 재돌파·피봇(R1·R2) 재돌파를 15초 주기로 함께 실시간 감시합니다(지금 보고 있는 서브모드 전체에 적용)"
                >
                  <Zap className="w-3 h-3 shrink-0" />
                  실시간 감시
                  {vwapWatchEnabled && (vwapWatchFetching || pivotWatchFetching) && <RefreshCw className="w-3 h-3 animate-spin" />}
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
                  눌림후속
                </button>
              </div>
              {/* 🚨 [순서 변경 - 사용자 요청: "실시간 감시 토글을 앞에 3토글 옆에 붙이고 기준 라벨은
                  뒤로 보내", 2026-09-23] 실시간 감시 버튼을 3개 서브모드 토글 바로 옆으로 옮기고,
                  "발굴/전조 기준" 라벨은 그 뒤로 민다. */}
              {/* 🎯 [기능 추가 - 사용자 요청: "토글들 계속 껏다켰다 하기 너무 힘든데"] VWAP·피봇 감시 버튼
                  2개를 하나로 합쳤다(수칙 1-6, 급등주 탭과 동일한 핸들러 재사용). */}
              <button
                type="button"
                onClick={handleRealtimeWatchToggle}
                className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                  vwapWatchEnabled
                    ? 'bg-gradient-to-r from-sky-600 to-violet-600 text-white border-transparent shadow-xs font-black'
                    : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                }`}
                title="켜면 VWAP 재돌파·피봇(R1·R2) 재돌파를 15초 주기로 함께 실시간 감시합니다"
              >
                <Zap className={`w-3.5 h-3.5 ${vwapWatchEnabled ? 'text-sky-200' : 'text-sky-600'}`} />
                <span>{vwapWatchEnabled ? '실시간 감시 중' : '실시간 감시'}</span>
                {vwapWatchEnabled && (vwapWatchFetching || pivotWatchFetching) && <RefreshCw className="w-3 h-3 animate-spin text-sky-100" />}
              </button>
              {/* 🎯 [기능 추가 - 사용자 요청: "장마감 후보들은 언제 업데이트 되는거야? 마지막 업데이트
                  시점이 언제인지 알려줘야 안헷갈릴거 같아 - 각자 토글 옆에"] 위 lastBatchTime/updatedAt을
                  그대로 노출한다 - 발굴/전조는 미리 당겨둔 데이터라 토글을 누르기 전에도 바로 보이고,
                  급등은 실제로 눌러서 조회한 뒤에만 뜬다(수칙 1-3, 안 물어본 값을 지어내지 않음). */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-slate-400 dark:text-slate-500 font-sans font-normal whitespace-nowrap">
                {formatBatchLabel(postmarketBatchData) && <span>급등 {formatBatchLabel(postmarketBatchData)}</span>}
                {formatBatchLabel(discoveryBatchData) && <span>발굴 {formatBatchLabel(discoveryBatchData)}</span>}
                {formatBatchLabel(precursorBatchData) && <span>전조 {formatBatchLabel(precursorBatchData)}</span>}
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
              {/* 🎯 [기능 추가 - 사용자 요청: "토글들 계속 껏다켰다 하기 너무 힘든데"] VWAP·피봇 감시 버튼
                  2개를 하나로 합쳤다(수칙 1-6, 급등주 탭과 동일한 핸들러 재사용). */}
              {!showDropouts && (
                <button
                  type="button"
                  onClick={handleRealtimeWatchToggle}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border shrink-0 ${
                    vwapWatchEnabled
                      ? 'bg-gradient-to-r from-sky-600 to-violet-600 text-white border-transparent shadow-xs font-black'
                      : 'bg-slate-100 dark:bg-[#1e222d] text-slate-600 dark:text-gray-400 border-slate-200/60 dark:border-[#2a2e39] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                  title="켜면 VWAP 재돌파·피봇(R1·R2) 재돌파를 15초 주기로 함께 실시간 감시합니다"
                >
                  <Zap className={`w-3.5 h-3.5 ${vwapWatchEnabled ? 'text-sky-200' : 'text-sky-600'}`} />
                  <span>{vwapWatchEnabled ? '실시간 감시 중' : '실시간 감시'}</span>
                  {vwapWatchEnabled && (vwapWatchFetching || pivotWatchFetching) && <RefreshCw className="w-3 h-3 animate-spin text-sky-100" />}
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
                      // 🚨 [전면 재정의 - "눌림후속"] 기존 4개 지표 점수식은 202거래일 실측에서 다음날
                      // 수익률과 상관계수 사실상 0으로 확인돼 제거(수칙 1-7) - 점수 없이 조건 2개
                      // (당일하락<-0.5%, 종가/고가 94~97%) 충족 여부만 보여준다.
                      // 🎯 [컬럼 추가 - 사용자 요청, 2026-09-23] 전체 유니버스 백테스트(200거래일 워크
                      // 포워드 9/9)에서 확정치 기준 "당일 외국인 순매수비율 상위20%"가 가장 안정적인
                      // 요인이었다. 다만 라이브 14:40 크론 시점엔 확정치가 아직 없고 14:30 가집계
                      // (HHPTJ04160200) 추정치만 있다 - 백테스트(확정치)와 라이브(가집계)가 다른 데이터
                      // 소스임을 헷갈리지 않도록 컬럼명에 "가집계"를 명시한다(수칙 1-9 취지 - 오인 방지).
                      <>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]">현재가</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="조건1: -0.5% 미만">당일 등락률</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="조건2: 94~97% (당일 하락 중 어중간하게 반등도 붕괴도 아닌 위치에서 마감)">종가/고가</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="14:30 장중 가집계(추정치) 기준 - 18:00+ 확정치와 다를 수 있음, 백테스트는 확정치 기준">외국인 가집계 순매수비율</th>
                        <th className="p-2.5 text-right whitespace-nowrap sticky top-0 z-20 bg-slate-100 dark:bg-[#1a1e29]" title="오늘 눌림후속 후보군 내 외국인 가집계 순매수비율 백분위 순위 (낮을수록 상위)">외국인 순위(%)</th>
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
                                자리·스타일로 통일한다 - R1/R2 재돌파 배지 안에 따로 표기하지 않는다.
                                🚨 [기능 재설계 - 사용자 지적: "그게 나오지 말고 피봇에 녹아들어서"] 정렬
                                자체가 이제 pivotWatchActive(R1/R2)로만 일어나므로(vwapOriginalRank도 그
                                때만 채워짐) 게이트를 pivotWatchActive 하나로 맞춘다. */}
                            {/* 🎯 [기능 추가 - 사용자 요청: "거래대금 하면 원래 순위가 몇이었는지도
                                알려줘야해"] "거래대금" 버튼으로 정렬 중일 때는, 위 rank 배지 자체가 이미
                                거래대금 순위로 바뀌어 있으므로 원래(정상 순서) 순위를 별도로 옆에 표기한다.
                                같은 자리를 두고 vwapOriginalRank 표기와 겹칠 수 있어 이 경우가 우선한다. */}
                            {sortField === 'amountEok' && (item as any).originalRank !== undefined ? (
                              <span className="text-[9px] text-slate-400 dark:text-slate-500 font-sans font-normal whitespace-nowrap shrink-0">
                                (원래 {(item as any).originalRank}위)
                              </span>
                            ) : (
                              pivotWatchActive && (item as any).vwapOriginalRank !== undefined && (
                                <span className="text-[9px] text-slate-400 dark:text-slate-500 font-sans font-normal whitespace-nowrap shrink-0">
                                  (전체 {(item as any).vwapOriginalRank}위)
                                </span>
                              )
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
                                얘네는 종목이 별로 없어서 따로 신용가능 토글을 쓰기가 애매해"] 재돌파 배지가
                                실제로 뜬 행에만(전체 목록 대상 별도 필터 토글 없이) 기존 3-상태 아이콘을 그대로
                                붙인다(수칙 1-6, 새 로직 아님 - MobileStockDetailChart.tsx가 쓰던 매핑 재사용).
                                🚨 [기능 재설계 - 사용자 지적: "번개로고가 vwap인거 아니야? 그게 나오지 말고
                                피봇에 녹아들어서 점수를 내야하는거라고"] VWAP는 더 이상 화면에 독립 배지로
                                뜨지 않으므로(R1/R2 정렬 우선순위에만 타이브레이커로 녹아든다, 아래 getWatchPriority
                                참고) 이 게이트도 R1/R2 조건만 남긴다. */}
                            {(() => {
                              const p = pivotWatchEnabled ? pivotReclaimMap?.get(item.symbol) : undefined;
                              const hasWatchBadge = !!(
                                p?.r1.approaching || p?.r1.reclaimed || p?.r1.hadPriorBreak || p?.r1.holding || p?.r1.sellPressureWarning ||
                                p?.r2.approaching || p?.r2.reclaimed || p?.r2.hadPriorBreak || p?.r2.holding || p?.r2.sellPressureWarning
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
                          <td className="p-2.5 font-sans min-w-[160px] max-w-[220px]">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {/* 🚨 [기능 재설계 - 사용자 지적: "번개로고가 vwap인거 아니야? 그게 나오지 말고
                                  피봇에 녹아들어서 점수를 내야하는거라고" - "지금 로고별로 나오잖아"] VWAP
                                  독립 배지(번개 아이콘, 재돌파 임박/매도 압박/돌파 완료/잦은 등락/이전이력)를
                                  전부 제거했다. 대우건설처럼 VWAP만 보고 "임박"이 떴다 안 떴다 하는 문제의
                                  근본 원인 - VWAP은 매 체결마다 자기 자신(누적거래대금/누적거래량)도 같이
                                  움직이는 값이라 가격-VWAP 간격이 가격뿐 아니라 VWAP 자체의 흔들림으로도
                                  좁혀졌다 넓혀졌다 한다. R1/R2는 전일 데이터로 하루 종일 고정이라 훨씬
                                  안정적이다(사용자 확정: "R1/R2 = 주된 돌파 레벨, VWAP = 보조 지표"). VWAP
                                  계산·로깅(reclaim_signal_events, outcome) 자체는 백엔드에서 계속 돌되,
                                  화면엔 R1/R2 정렬 우선순위의 동점 타이브레이커로만 녹아든다(getWatchPriority
                                  참고) - 화면에 별도 아이콘/태그로 다시 드러나지 않는다. */}
                              {/* 🚨 [기능 보강 - 사용자 지적: "이미 재돌파 하고나면 내가 또 못사잖아"] 아직
                                  안 뚫었지만 곧 뚫을 것 같은 "임박"(선행, 액션 가능)과 이미 다 끝난 "완료"
                                  (후행, 참고용)를 색으로 구분한다 - 임박이 실제로 사려는 시점에 더 유용하다. */}
                              {/* 🎯 [기능 재설계 - 사용자 지적: "뭔 다 확인 불가라고 떠?", "현재가랑 겹치잖아
                                  뱃지가", "대우건설이 무슨 잦은등락이야, 지금 계속 고가 뚫고 가는구만" -
                                  "재돌파 임박 → 재돌파 확인 → 돌파 완료 → 완료 후 5분 경과 순으로 정렬하고
                                  신선도를 넣어"] "타이밍 확인불가"라는 긴 배지를 없애고(elapsedMs가 항상
                                  채워지므로 더 이상 그 상태가 없음), 경과시간 기반 3단계 배지로 교체했다.
                                  짧은 문구로 바꿔서 "감시 신호" 칸이 옆 "현재가" 칸과 겹치던 문제도 함께
                                  해결한다(td에 max-w까지 둬서 재발도 방지). "잦은 등락"도 elapsedMs가
                                  5분 이상(최근에 안정적으로 유지 중)이면 더 이상 붙지 않는다. */}
                              {/* 🎯 [기능 추가 - 사용자 요청: "R2까지 안가고 R1까지 뚫었어도... 다시 올라올거
                                  같은 반등"] R2가 걸려있으면 R2를(더 강한 신호), 아니면 R1을 표시한다. */}
                              {pivotWatchEnabled && (() => {
                                const p = pivotReclaimMap?.get(item.symbol);
                                if (!p) return null;
                                // 🚨 [재설계 - 사용자 지적: "저렇게 박스를 하는게 내가 3분봉 보고 매매에
                                // 대해 도움이 되나? 박스권 하락, 박스권 돌파 이런걸 원했던건데... 순위표
                                // 배지로"] R1/R2와 무관한 순수 가격 흐름 신호(priceLeg)를 R1/R2별 배지보다
                                // 먼저, 최우선으로 보여준다 - 사용자가 실제로 원한 "지금 매매에 참고할 상태"
                                // 이기 때문이다. RankingStockDetailChart.tsx의 파랑(상승)/보라(하락) 색을
                                // 그대로 재사용한다(수칙 1-6).
                                if (p.priceLeg?.type === 'up') {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60 flex items-center gap-0.5"
                                      title={`순수 가격 흐름만으로 판단: 최근 ${p.priceLeg.durationMs >= 3600000 ? `${Math.floor(p.priceLeg.durationMs / 3600000)}시간 ${Math.round((p.priceLeg.durationMs % 3600000) / 60000)}분` : `${Math.round(p.priceLeg.durationMs / 60000)}분`}간 ${p.priceLeg.changePct >= 0 ? '+' : ''}${p.priceLeg.changePct}% 상승 중(박스권재돌파) - R1/R2 여부와 무관`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      박스권재돌파(+{p.priceLeg.changePct}%)
                                    </span>
                                  );
                                }
                                if (p.priceLeg?.type === 'down') {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/60 flex items-center gap-0.5"
                                      title={`순수 가격 흐름만으로 판단: 최근 ${p.priceLeg.durationMs >= 3600000 ? `${Math.floor(p.priceLeg.durationMs / 3600000)}시간 ${Math.round((p.priceLeg.durationMs % 3600000) / 60000)}분` : `${Math.round(p.priceLeg.durationMs / 60000)}분`}간 ${p.priceLeg.changePct}% 하락 중(고점 찍고 내려가는 중) - R1/R2 여부와 무관`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      박스권 하락({p.priceLeg.changePct}%)
                                    </span>
                                  );
                                }
                                if (p.priceLeg?.type === 'box') {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 flex items-center gap-0.5"
                                      title={`순수 가격 흐름만으로 판단: 최근 고점·저점이 반복해서 ±${(p.priceLeg.changePct / 2).toFixed(2)}% 범위 안에 갇혀 횡보 중입니다 - R1/R2 여부와 무관`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      박스권 유지(±{(p.priceLeg.changePct / 2).toFixed(2)}%)
                                    </span>
                                  );
                                }
                                // 🚨 [버그 수정 - 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"]
                                // holding(처음 뚫은 뒤 한 번도 안 내려가고 계속 위)도 레벨 선택에 포함.
                                const level: 'R2' | 'R1' | null =
                                  p.r2.approaching || p.r2.reclaimed || p.r2.holding ? 'R2'
                                  : p.r1.approaching || p.r1.reclaimed || p.r1.holding ? 'R1'
                                  : p.r2.sellPressureWarning ? 'R2'
                                  : p.r1.sellPressureWarning ? 'R1'
                                  : p.r2.hadPriorBreak ? 'R2'
                                  : p.r1.hadPriorBreak ? 'R1' : null;
                                if (!level) return null;
                                const sig = level === 'R2' ? p.r2 : p.r1;
                                // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?"] 오늘
                                // 이 선을 2번째 이상 (재)시도 중일 때만 "N번째 시도"를 덧붙인다 - 첫 돌파는
                                // "재시도"라고 부를 게 없어서(crossCount===1) 굳이 안 보여준다.
                                // 🚨 [버그 수정 - 사용자 지적: "뱃지 겹치잖아. 안겹치게 예쁘게 만들어"] 배지
                                // 문구 안에 이어 붙이면 텍스트가 길어져 "감시 신호" 칸 폭을 넘어 옆 "현재가"
                                // 칸과 겹쳤다(실측: 최대 43px 침범). 배지 밖의 별도 작은 텍스트로 분리해서
                                // 부모 flex-wrap 컨테이너가 필요할 때 자동으로 다음 줄로 넘기게 한다.
                                const crossLabel = sig.crossCount >= 2 ? `${sig.crossCount}번째 시도` : '';
                                const crossLabelSpan = crossLabel ? (
                                  <span className="text-[8px] text-slate-400 dark:text-slate-500 font-sans font-normal shrink-0">
                                    {crossLabel}
                                  </span>
                                ) : null;
                                if (sig.approaching) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/40 flex items-center gap-0.5 animate-pulse"
                                      title={`${level}을(를) 뚫었다가 눌린 뒤, 다시 ${level}을(를) 향해 간격이 좁혀지고 거래량이 붙기 시작했습니다`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      {level} 재돌파 임박
                                    </span>
                                  );
                                }
                                {/* 🎯 [기능 추가 - VWAP과 동일(수칙 1-6)] 거래량은 늘었지만 매도 우위라 임박에서 제외됨. */}
                                if (sig.sellPressureWarning) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-rose-50 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400 border-rose-200 dark:border-rose-800/50 flex items-center gap-0.5"
                                      title={`${level} 간격이 좁혀지고 거래량도 늘었지만, 그 거래량이 매도 우위입니다 - 재돌파 임박으로 보지 않습니다(참고용)`}
                                    >
                                      <Target className="w-2.5 h-2.5" />
                                      {level} 매도 압박
                                    </span>
                                  );
                                }
                                {/* 🎯 [기능 추가 - 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"]
                                    처음 뚫은 뒤 한 번도 안 내려가고 계속 유지 중(재돌파 이력은 아직 없음) -
                                    reclaimed(재돌파)보다는 약하지만 hadPriorBreak(이전이력만)보다는 강한
                                    신호라 별도 색으로 구분한다. */}
                                if (sig.holding && sig.elapsedMs != null) {
                                  const info = computeReclaimFreshnessInfo(sig.elapsedMs, sig.crossCount);
                                  return (
                                    <>
                                      <span
                                        className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/60 flex items-center gap-0.5"
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
                                  // VWAP과 동일한 신선도 재설계(수칙 1-6) - reclaimed(가격만, 즉시)는
                                  // 그대로 보여주고, elapsedMs로 방금 확인/유지 중/오래된 완료를 구분한다.
                                  // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?"] 피봇도
                                  // 이제 crossCount를 추적하므로 VWAP과 동일하게 넘긴다(수칙 1-6).
                                  const info = computeReclaimFreshnessInfo(sig.elapsedMs, sig.crossCount);
                                  if (info.tier === 'justConfirmed') {
                                    return (
                                      <>
                                        <span
                                          className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-purple-50/60 dark:bg-purple-950/30 text-purple-400 dark:text-purple-500 border-purple-100 dark:border-purple-900/60 flex items-center gap-0.5"
                                          title={`방금(${info.elapsedLabel} 전) ${level}을(를) 재돌파했습니다 - 순간적으로 삐죽 올라간 것인지 아직 힘을 확인하는 중입니다(신뢰도 낮음) - 오늘 ${level} 돌파 시도 ${sig.crossCount}번째`}
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
                                        className={`text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border flex items-center gap-0.5 ${staleClass}`}
                                        title={`${info.elapsedLabel} 전 ${level}을(를) 재돌파해 계속 유지 중입니다${sig.volSurge ? ' - 거래량 속도도 여전히 높습니다' : ''}(참고용${info.tier === 'established' ? ', 진입 시점은 이미 지났을 수 있음' : ''}) - 오늘 ${level} 돌파 시도 ${sig.crossCount}번째`}
                                      >
                                        <Target className="w-2.5 h-2.5" />
                                        {level} 완료({info.elapsedLabel}){sig.volSurge ? '·거래량↑' : ''}
                                      </span>
                                      {crossLabelSpan}
                                    </>
                                  );
                                }
                                {/* 🎯 [기능 재설계 - 사용자 요청: "박스구간 뚫고 내려오면 돌파후하락"] "이전이력
                                    (대기)"라는 모호한 문구 대신, 뚫었다가 다시 아래로 내려간 상태임을 명확히
                                    드러낸다(로직 자체는 그대로 - hadPriorBreak, 문구만 재배치). */}
                                if (sig.hadPriorBreak) {
                                  return (
                                    <span
                                      className="text-[9px] px-1 py-0.2 rounded font-sans font-bold shrink-0 border bg-slate-50 dark:bg-slate-900/60 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700/60 flex items-center gap-0.5 opacity-70"
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
                              <span className="text-blue-600 dark:text-blue-400">
                                {item.changeRate.toFixed(2)}%
                              </span>
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.closeToHighRatioPct != null ? `${item.closeToHighRatioPct.toFixed(2)}%` : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono whitespace-nowrap">
                              {item.foreignRatioEstimate != null ? (
                                <span className={item.foreignRatioEstimate >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                                  {item.foreignRatioEstimate >= 0 ? '+' : ''}{item.foreignRatioEstimate.toFixed(2)}%
                                </span>
                              ) : '-'}
                            </td>
                            <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {item.foreignRatioEstimateRankPct != null ? (
                                <span className={item.foreignRatioEstimateTop20 ? 'font-bold text-amber-600 dark:text-amber-400' : ''}>
                                  상위 {item.foreignRatioEstimateRankPct.toFixed(1)}%
                                </span>
                              ) : '-'}
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
