'use client';

// 데스크톱 RankingStockDetailChart.tsx의 "3분봉" 탭 모바일 버전 - 캔들스틱 + MA5/20/60 +
// VWAP(±1·2σ 밴드) + 피봇/피보나치 매매신호 + 단기 지지선(스윙 로우) + 매물대 + 거래량.
// MA/VWAP/피봇·피보나치 레벨은 전부 백엔드(intraday-chart API, data.levels)가 이미 계산해서 내려준다 -
// 프론트에서 새로 계산하지 않는다(수칙 1-6). 스윙 로우 탐지(findActiveSwingLow)/R1 돌파 판정
// (isR1Flipped)만 RankingStockDetailChart.tsx 654~698번 줄 로직을 그대로 이식했다(해당 함수가
// export되어 있지 않아 재사용할 수 없었음 - 계산 공식 자체는 100% 동일).
// 캔들 렌더링/툴팁은 CandlestickPrimitives.tsx 공통 모듈을 재사용한다.

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { IntradayChartResponse } from '@/lib/types';
import { useTheme } from '@/providers/ThemeProvider';
import { PRICE_CHART_CONFIG, CandlestickBar } from '@/components/chart/CandlestickPrimitives';
import MobileLoadingSpinner from './MobileLoadingSpinner';

// 🚨 [버그 수정] 사용자 지적("3분봉이 너무 좁아서 겹쳐보여", "피봇/단기지지선 정보가 다 없어졌다") 실측 확인:
// (1) 전일+당일 최대 130개 캔들을 375px 화면 폭(실질 플롯 폭 ~277px)에 강제로 욱여넣어 캔들 하나당
//     2px 남짓이라 몸통/꼬리 구분이 아예 안 됐다. (2) 피봇/피보나치/단기지지 레퍼런스라인이 가격이 서로
//     가까울 때(예: S1·38.2%·50% 레벨이 1,500원 안에 몰림) 라벨 텍스트끼리 세로로 겹쳐 사실상 읽을 수
//     없어졌다 - API(levels.pivot/fibonacci)는 정상 응답하는 걸 실측으로 확인했으므로 데이터가 아니라
//     순전히 레이아웃 문제였다. 해결: 캔들 최소폭을 보장하는 가로 스크롤(터치 페이지 스크롤과 충돌 없음 -
//     세로 스크롤은 페이지가, 가로 스크롤은 이 차트가 담당) + 라벨 세로 충돌 회피(우선순위가 낮은 라벨은
//     선은 유지하되 텍스트만 생략)로 둘 다 잡는다. 차트 높이도 180→208로 늘려 라벨 여유를 추가로 확보한다.
const PRICE_CHART_HEIGHT = 208;
const PRICE_TOP_PADDING = 10;
const PRICE_PLOT_HEIGHT = PRICE_CHART_HEIGHT - PRICE_TOP_PADDING;
const MIN_CANDLE_PX = 8; // 캔들 1개당 최소 폭 - 사용자 요청으로 5→8 확대(어차피 가로 스크롤하니 더 크게 봐도 됨)

interface MobileIntraday3mChartProps {
  symbol: string;
}

interface SwingLowPoint {
  price: number;
  time: string;
  index: number;
}

// RankingStockDetailChart.tsx 654~687번 줄과 동일한 공식(지역 국소 최저점 탐지 + 그 이후 종가가
// 한 번도 그 밑으로 떨어지지 않은 "아직 유효한" 스윙 로우만 채택) - export되어 있지 않아 그대로 이식.
function findActiveSwingLow(candles: any[]): SwingLowPoint | null {
  if (!candles || candles.length < 5) return null;
  const swingLows: SwingLowPoint[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const currLow = candles[i].lowPrice;
    if (
      currLow < candles[i - 2].lowPrice &&
      currLow < candles[i - 1].lowPrice &&
      currLow <= candles[i + 1].lowPrice &&
      currLow <= candles[i + 2].lowPrice
    ) {
      swingLows.push({ price: currLow, time: candles[i].time, index: i });
    }
  }
  const activeSwingLows = swingLows.filter((sl) => {
    for (let k = sl.index + 1; k < candles.length; k++) {
      if (candles[k].closePrice < sl.price) return false;
    }
    return true;
  });
  if (activeSwingLows.length === 0) return null;
  return activeSwingLows[activeSwingLows.length - 1];
}

// RankingStockDetailChart.tsx의 getKrxTickSize/피봇 연동 축 계산만큼 정교하진 않지만, MobileStockDetailChart.tsx
// 의 calculatePriceAxis와 동일한 단순 nice-number 방식으로 1차 버전을 충분히 커버한다.
function calculatePriceAxis(minRaw: number, maxRaw: number, targetTicks = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0 || maxRaw <= minRaw) {
    return { priceDomain: [0, 100] as [number, number], priceTicks: [0, 20, 40, 60, 80, 100] };
  }
  const range = maxRaw - minRaw;
  const pad = Math.max(range * 0.08, 1);
  const rawMin = Math.max(0, minRaw - pad);
  const rawMax = maxRaw + pad;
  const rawStep = (rawMax - rawMin) / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / magnitude;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceNorm * magnitude;
  const startP = Math.floor(rawMin / step) * step;
  const endP = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  for (let p = startP; p <= endP + step * 0.01; p += step) ticks.push(Math.round(p));
  return { priceDomain: [startP, endP] as [number, number], priceTicks: ticks };
}

function isMarketOpenNowKst(): boolean {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const day = kst.getDay();
  const timeNum = kst.getHours() * 100 + kst.getMinutes();
  return day >= 1 && day <= 5 && timeNum >= 900 && timeNum < 1530;
}

// 🚨 [재도입] MobileStockDetailChart.tsx가 일간 탭이 열리자마자 이 함수로 prefetchQuery를 걸어 3분봉을
// 백그라운드에서 미리 당겨둔다. 한 번 껐다가(fetchKis3mCandlesFullDay의 kisQueue 미사용 결함으로 인한
// 프로덕션 회귀) 그 결함을 근본 수정한 뒤 다시 켰다 - queryKey(['m-intraday3m', symbol])를 여기
// useQuery와 반드시 동일하게 맞춰야 캐시가 재사용된다.
export async function fetchIntraday3m(symbol: string): Promise<IntradayChartResponse> {
  const res = await fetch(`/api/stock/intraday-chart?symbol=${symbol}&timeUnit=3m&t=${Date.now()}`);
  if (!res.ok) throw new Error('3분봉 데이터를 불러오는데 실패했습니다.');
  return res.json();
}

export default function MobileIntraday3mChart({ symbol }: MobileIntraday3mChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const axisColor = isDark ? '#94a3b8' : '#475569';

  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(false);
  const [showVWAP, setShowVWAP] = useState(true);
  const [showPivot, setShowPivot] = useState(true);
  const [showFibo, setShowFibo] = useState(true);
  const [showVolumeProfile, setShowVolumeProfile] = useState(true);

  // 🚨 [사용자 요청 - 재변경] 처음엔 Recharts 기본 Tooltip이 모바일 터치에서 안 닫히고 차트를 계속
  // 가리는 문제(마우스 "벗어남" 이벤트가 터치엔 없음) 때문에 차트 밖 고정 바 방식으로 바꿨었는데,
  // 이번엔 "다른 모바일 일봉 차트들처럼 팝업으로 띄워달라"는 요청을 받았다. 다만 Recharts Tooltip
  // 자체를 다시 쓰진 않는다(그 근본 문제가 그대로 재발함) - 대신 탭 좌표(clientX/Y)를 직접 저장해서
  // 그 위치에 우리가 만든 카드를 position:fixed로 띄운다. 화면(뷰포트) 기준 고정이라 가로 스크롤 위치와
  // 무관하게 항상 탭한 자리에 정확히 뜨고, 차트 컨테이너 바깥을 탭하면(기존 로직 그대로) 사라진다.
  const [selectedCandle, setSelectedCandle] = useState<any | null>(null);
  const [tapPos, setTapPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleOutsideTap = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSelectedCandle(null);
        setTapPos(null);
      }
    };
    document.addEventListener('click', handleOutsideTap);
    return () => document.removeEventListener('click', handleOutsideTap);
  }, []);

  const isMarketOpen = React.useMemo(() => isMarketOpenNowKst(), []);

  const { data, isLoading } = useQuery<IntradayChartResponse>({
    queryKey: ['m-intraday3m', symbol],
    queryFn: () => fetchIntraday3m(symbol),
    enabled: Boolean(symbol),
    staleTime: 30 * 1000,
    refetchInterval: isMarketOpen ? 30 * 1000 : false,
  });

  const candles = data?.candles || [];
  const levels = data?.levels;

  // R1(1차 익절 저항) 돌파 시 지지선으로 전환 - RankingStockDetailChart.tsx 694~698번 줄과 동일 공식.
  const isR1Flipped = React.useMemo(() => {
    const r1 = levels?.pivot?.r1;
    if (!r1 || candles.length === 0) return false;
    return candles.some((c: any) => (c.highPrice || c.closePrice) >= r1);
  }, [levels, candles]);

  const activeSwingLow = React.useMemo(() => findActiveSwingLow(candles), [candles]);

  const { minPrice, maxPrice, priceDomain, priceTicks } = React.useMemo(() => {
    if (candles.length === 0) return { minPrice: 0, maxPrice: 100, ...calculatePriceAxis(0, 100) };
    const vals: number[] = [];
    candles.forEach((c) => {
      const o = c.openPrice || c.closePrice;
      const h = c.highPrice || Math.max(o, c.closePrice);
      const l = c.lowPrice || Math.min(o, c.closePrice);
      vals.push(o, h, l, c.closePrice);
      if (showVWAP) {
        if (c.vwapUpper2) vals.push(c.vwapUpper2);
        if (c.vwapLower2) vals.push(c.vwapLower2);
      }
    });
    if (showPivot && levels?.pivot) {
      if (levels.pivot.r1 > 0) vals.push(levels.pivot.r1);
      if (levels.pivot.s1 > 0) vals.push(levels.pivot.s1);
    }
    if (showFibo && levels?.fibonacci) {
      if (levels.fibonacci.fibo382 > 0) vals.push(levels.fibonacci.fibo382);
      if (levels.fibonacci.fibo500 > 0) vals.push(levels.fibonacci.fibo500);
    }
    if (activeSwingLow) vals.push(activeSwingLow.price);
    const axis = calculatePriceAxis(Math.min(...vals), Math.max(...vals));
    return { minPrice: axis.priceDomain[0], maxPrice: axis.priceDomain[1], ...axis };
  }, [candles, showVWAP, showPivot, showFibo, levels, activeSwingLow]);

  // 3분봉 매물대(가격대별 누적 거래량) - 일간 차트(MobileStockDetailChart.tsx)와 동일한 방식(대표가에
  // 해당 봉 실거래량 배정)을 3분봉 단위로 그대로 적용한다(RankingStockDetailChart.tsx 779~816번 줄과
  // 동일 공식, 가짜 데이터 없이 실 3분봉 OHLCV만 사용, 수칙 1-6).
  const volumeProfileBins = React.useMemo(() => {
    if (!showVolumeProfile || candles.length === 0 || minPrice <= 0 || maxPrice <= minPrice) return [];
    const BIN_COUNT = 24;
    const binSize = (maxPrice - minPrice) / BIN_COUNT;
    const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({ priceLow: minPrice + i * binSize, priceHigh: minPrice + (i + 1) * binSize, volume: 0 }));
    candles.forEach((c) => {
      const cl = c.closePrice || 0;
      if (cl <= 0) return;
      const o = (c.openPrice && c.openPrice > 0) ? c.openPrice : cl;
      const h = (c.highPrice && c.highPrice > 0) ? c.highPrice : Math.max(o, cl);
      const l = (c.lowPrice && c.lowPrice > 0) ? c.lowPrice : Math.min(o, cl);
      const vol = c.volume || 0;
      if (vol <= 0) return;
      const typicalPrice = (h + l + cl) / 3;
      const idx = Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((typicalPrice - minPrice) / binSize)));
      bins[idx].volume += vol;
    });
    const maxBinVolume = Math.max(1, ...bins.map((b) => b.volume));
    let pocIdx = 0;
    bins.forEach((b, i) => { if (b.volume > bins[pocIdx].volume) pocIdx = i; });
    return bins.map((b, i) => ({ ...b, ratio: b.volume / maxBinVolume, isPoc: i === pocIdx && b.volume > 0 }));
  }, [showVolumeProfile, candles, minPrice, maxPrice]);

  const formatYPrice = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const formatYVol = (v: number) => (v >= 100000000 ? `${Math.round(v / 100000000)}억` : v >= 10000 ? `${Math.round(v / 10000)}만` : v.toLocaleString());

  // 캔들 1개당 최소폭(MIN_CANDLE_PX)을 보장하는 전체 차트 폭 - 375px 화면보다 넓어지면 가로 스크롤됨.
  const chartWidth = Math.max(candles.length * MIN_CANDLE_PX, 320);

  // 🚨 [사용자 피드백 반영] 라벨 세로 충돌을 "안 겹치는 것만 텍스트로 보여주는" 방식으로 1차 수정했었는데,
  // 사용자가 아예 "그래프 오른쪽 글씨 다 없애고 밑에 범례로 확실하게 보여달라"고 재요청했다 - 화면 폭이
  // 좁은 모바일에서는 라벨이 몇 개만 남아도 여전히 좁고, 위에 있는 7개 피봇 카드 그리드가 정확한 값을
  // 이미 다 보여주므로 차트 안 텍스트는 전부 제거하고 아래 범례에서 색상별로 명확히 안내한다.

  // 데이터가 바뀌면(최초 로드/자동 갱신) 항상 가장 최근 캔들(오른쪽 끝)이 보이도록 스크롤 위치를 맞춘다 -
  // 트레이더에게 가장 중요한 건 방금 막 형성된 캔들이라 왼쪽(하루 시작)에서 시작하면 매번 다시 스크롤해야 함.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [candles.length]);

  if (isLoading) {
    return <MobileLoadingSpinner label="3분봉 데이터를 불러오는 중입니다..." />;
  }
  if (candles.length === 0) {
    return <div className="py-10 text-center text-slate-400 text-xs">표시할 3분봉 데이터가 없습니다.</div>;
  }

  return (
    <div ref={containerRef}>
      {data?.statusNotice && (
        <div className="mb-2 px-2 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 text-[10px]">
          {data.statusNotice}
        </div>
      )}

      {/* 지표 토글 */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {[
          { key: 'ma5', label: '5선', active: showMA5, setter: setShowMA5, color: 'text-orange-500 border-orange-500/40' },
          { key: 'ma20', label: '20선', active: showMA20, setter: setShowMA20, color: 'text-yellow-600 border-yellow-500/40' },
          { key: 'ma60', label: '60선', active: showMA60, setter: setShowMA60, color: 'text-purple-500 border-purple-500/40' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => t.setter((v) => !v)}
            className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${t.active ? `bg-white dark:bg-[#1e222d] ${t.color}` : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => setShowVWAP((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showVWAP ? 'bg-white dark:bg-[#1e222d] text-indigo-600 dark:text-indigo-400 border-indigo-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          VWAP(±1·2σ)
        </button>
        <button
          onClick={() => setShowPivot((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showPivot ? 'bg-white dark:bg-[#1e222d] text-red-600 dark:text-red-400 border-red-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          피봇
        </button>
        <button
          onClick={() => setShowFibo((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showFibo ? 'bg-white dark:bg-[#1e222d] text-emerald-600 dark:text-emerald-400 border-emerald-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          피보나치
        </button>
        <button
          onClick={() => setShowVolumeProfile((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showVolumeProfile ? 'bg-white dark:bg-[#1e222d] text-slate-500 dark:text-slate-300 border-slate-400/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          매물대
        </button>
      </div>

      {/* 🚨 [기능 복원] 사용자 지적("피봇신고가, 단기지지선 같은 정보들 다 없어졌다")의 실제 정체 - 차트
          위에 그려지는 ReferenceLine 라벨과는 별개로, 데스크톱(RankingStockDetailChart.tsx 968~1013번 줄)
          에는 7개 핵심 가격을 숫자로 바로 읽을 수 있는 카드 그리드가 따로 있었는데 모바일엔 애초에 이식이
          안 돼 있었다. 색상/라벨/값 전부 데스크톱과 100% 동일하게 그대로 이식한다(수칙 1-6). */}
      {levels && (
        // 🚨 [사용자 요청] 2열이면 7개 카드가 4줄이 돼 스크롤이 길어진다는 지적 - 3열(3줄, 마지막 줄 1개)로
        // 바꾸면서 카드 폭이 줄어드는 만큼, 값(최대 7자리 "1,234,000원" 등 백만원대까지)이 잘리지 않도록
        // 좌우 패딩/간격을 줄이고 whitespace-nowrap으로 숫자가 중간에 줄바꿈되지 않게 고정한다.
        <div className="grid grid-cols-3 gap-1 text-center w-full mb-2">
          <div className="p-1 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-600 dark:text-orange-400">
            <div className="text-[8.5px] font-bold leading-tight">🟠 피봇 R2(신고가)</div>
            <div className="font-mono font-black text-[11px] whitespace-nowrap">{levels.pivot.r2.toLocaleString()}원</div>
          </div>
          <div className="p-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400">
            <div className="text-[8.5px] font-bold leading-tight">🔴 1차 익절(R1)</div>
            <div className="font-mono font-black text-[11px] whitespace-nowrap">{levels.pivot.r1.toLocaleString()}원</div>
          </div>
          <div className="p-1 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 dark:text-yellow-400">
            <div className="text-[8.5px] font-bold leading-tight">🟡 피봇 P(중심)</div>
            <div className="font-mono font-black text-[11px] whitespace-nowrap">{levels.pivot.p.toLocaleString()}원</div>
          </div>
          <div className="p-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-600 dark:text-cyan-400">
            <div className="text-[8.5px] font-bold leading-tight">💠 단기 지지선</div>
            <div className="font-mono font-black text-[11px] whitespace-nowrap">{activeSwingLow ? `${activeSwingLow.price.toLocaleString()}원` : '미형성'}</div>
          </div>
          <div className="p-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
            <div className="text-[8.5px] font-bold leading-tight">🟢 최적 매수(38.2%)</div>
            <div className="font-mono font-black text-[11px] whitespace-nowrap">{levels.fibonacci.fibo382.toLocaleString()}원</div>
          </div>
          <div className="p-1 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-600 dark:text-purple-400">
            <div className="text-[8.5px] font-bold leading-tight">⛔ 손절선(50.0%)</div>
            <div className="font-mono font-black text-[11px] whitespace-nowrap">{levels.fibonacci.fibo500.toLocaleString()}원</div>
          </div>
          <div className="p-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400">
            <div className="text-[8.5px] font-medium leading-tight">🔵 피봇 S1(지지)</div>
            <div className="font-mono font-bold text-[11px] whitespace-nowrap">{levels.pivot.s1.toLocaleString()}원</div>
          </div>
        </div>
      )}

      {/* 🚨 [사용자 요청] 캔들을 탭하면 다른 모바일 일봉 차트들과 동일하게 팝업 카드로 띄운다. 탭 좌표
          (tapPos)에 position:fixed로 앵커링해 화면 밖으로 넘치지 않게 clamp하고, 차트 컨테이너 바깥을
          탭하면(위 useEffect) 사라진다 - 탭 안 했을 때는 아무것도 안 뜬다(다른 일봉 팝업과 동일 동작). */}
      {selectedCandle && tapPos && (() => {
        const info = selectedCandle;
        const openPrice = info.openPrice ?? info.closePrice;
        const highPrice = info.highPrice ?? info.closePrice;
        const lowPrice = info.lowPrice ?? info.closePrice;
        const closePrice = info.closePrice;
        const isUp = closePrice >= openPrice;
        const rate = openPrice > 0 ? ((closePrice - openPrice) / openPrice) * 100 : 0;
        // 팝업 카드 예상 크기 기준으로 화면 밖으로 넘치지 않게 좌표를 clamp한다.
        const POPUP_W = 168;
        const POPUP_H = 108;
        const MARGIN = 8;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 375;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 812;
        const left = Math.min(Math.max(tapPos.x - POPUP_W / 2, MARGIN), vw - POPUP_W - MARGIN);
        // 기본은 탭 지점 위쪽에 띄우고, 화면 위로 넘치면 아래쪽으로 뒤집는다.
        const preferAbove = tapPos.y - POPUP_H - 14 > MARGIN;
        const top = preferAbove ? tapPos.y - POPUP_H - 14 : Math.min(tapPos.y + 14, vh - POPUP_H - MARGIN);
        return (
          <div
            className="fixed z-50 px-2.5 py-2 rounded-xl bg-white/95 dark:bg-[#1e222d]/95 backdrop-blur-md border border-slate-200 dark:border-[#2a2e39] shadow-xl text-[10px] font-mono space-y-1"
            style={{ left, top, width: POPUP_W }}
          >
            <div className="font-bold text-slate-500 dark:text-slate-400 pb-1 border-b border-slate-100 dark:border-slate-800">
              {info.time}
            </div>
            <div className="flex justify-between"><span className="text-slate-400">시</span><b className="text-slate-700 dark:text-slate-200">{Math.round(openPrice).toLocaleString()}</b></div>
            <div className="flex justify-between"><span className="text-red-500">고</span><b className="text-red-500">{Math.round(highPrice).toLocaleString()}</b></div>
            <div className="flex justify-between"><span className="text-blue-500">저</span><b className="text-blue-500">{Math.round(lowPrice).toLocaleString()}</b></div>
            <div className="flex justify-between border-t border-slate-100 dark:border-slate-800 pt-1">
              <span className="text-slate-400">종</span>
              <span className="flex items-center gap-1">
                <b className="text-slate-900 dark:text-white">{Math.round(closePrice).toLocaleString()}</b>
                <b className={isUp ? 'text-red-500' : 'text-blue-500'}>{isUp ? '+' : ''}{rate.toFixed(2)}%</b>
              </span>
            </div>
          </div>
        );
      })()}

      {/* 캔들스틱 + 매물대 오버레이 + 거래량 - 전부 하나의 가로 스크롤 영역 안에서 같은 폭(chartWidth)을
          공유해야 캔들/매물대/거래량 막대가 스크롤해도 서로 어긋나지 않는다. 세로 스크롤은 페이지가,
          가로 스크롤은 이 영역만 담당(overflow-x-auto)해서 서로 충돌하지 않는다. */}
      {/* 🚨 [사용자 요청] "가로 스크롤하면 y축 가격도 같이 스크롤돼서 얼마인지 안 보인다" - 캔들 영역만
          overflow-x-auto로 스크롤시키고, 가격 눈금은 그 왼쪽에 완전히 별도의(스크롤 안 되는) 고정
          컬럼으로 뺀다. 내부 Recharts YAxis는 폭(52px)만 그대로 유지한 채 눈금 렌더링만 끄고(레이아웃/
          CandlestickBar·매물대 오버레이의 기존 좌표 계산은 전혀 안 건드림), 화면에 보이는 실제 숫자는
          이 고정 컬럼의 순수 HTML 라벨이 담당 - 스크롤과 무관하게 항상 왼쪽에 그대로 보인다. */}
      <div className="flex">
      <div className="shrink-0 relative" style={{ width: 52, height: PRICE_CHART_HEIGHT }}>
        {priceTicks.map((t) => (
          <div
            key={`fixed-ytick-${t}`}
            className="absolute text-[9px] font-mono"
            style={{ top: PRICE_TOP_PADDING + (1 - (t - minPrice) / (maxPrice - minPrice)) * PRICE_PLOT_HEIGHT - 6, left: 2, color: axisColor }}
          >
            {formatYPrice(t)}
          </div>
        ))}
      </div>
      <div ref={scrollRef} className="overflow-x-auto flex-1 min-w-0">
      <div style={{ width: chartWidth }}>
      <div className="relative">
      <ResponsiveContainer width="100%" height={PRICE_CHART_HEIGHT}>
        <ComposedChart
          data={candles}
          margin={{ top: PRICE_TOP_PADDING, right: 10, left: -10, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
          <XAxis dataKey="time" hide={true} />
          <YAxis stroke={axisColor} tick={false} axisLine={false} tickLine={false} width={52} domain={priceDomain} ticks={priceTicks} allowDataOverflow={true} />
          {selectedCandle && <ReferenceLine x={selectedCandle.time} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />}
          <Bar dataKey="closePrice" name="캔들스틱" shape={(props: any) => <CandlestickBar {...props} minPrice={minPrice} maxPrice={maxPrice} topPadding={PRICE_TOP_PADDING} plotHeight={PRICE_PLOT_HEIGHT} />} isAnimationActive={false} />
          {showMA5 && <Line type="monotone" dataKey="ma5" stroke="#f97316" strokeDasharray="3 3" strokeWidth={1} dot={false} isAnimationActive={false} name="5선" />}
          {showMA20 && <Line type="monotone" dataKey="ma20" stroke="#eab308" strokeDasharray="3 3" strokeWidth={2} dot={false} isAnimationActive={false} name="20선" />}
          {showMA60 && <Line type="monotone" dataKey="ma60" stroke="#a855f7" strokeDasharray="3 3" strokeWidth={1} dot={false} isAnimationActive={false} name="60선" />}
          {showVWAP && <Line type="monotone" dataKey="vwap" stroke="#6366f1" strokeWidth={1.5} dot={false} isAnimationActive={false} name="VWAP" />}
          {showVWAP && (
            <>
              <Line type="monotone" dataKey="vwapUpper1" stroke="#2F9D27" strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="VWAP +1σ" />
              <Line type="monotone" dataKey="vwapLower1" stroke="#2F9D27" strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="VWAP -1σ" />
              <Line type="monotone" dataKey="vwapUpper2" stroke="#8FCB89" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} name="VWAP +2σ" />
              <Line type="monotone" dataKey="vwapLower2" stroke="#8FCB89" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} name="VWAP -2σ" />
            </>
          )}
          {/* 피봇 수평선 - R2(신고가)는 주가가 R1의 98% 이상 근접/돌파했을 때만(데스크톱과 동일 조건).
              어떤 선인지는 텍스트 라벨 대신 위 카드 그리드(정확한 값)와 아래 범례(색상 안내)로 보여준다 -
              사용자 요청("오른쪽 글씨 없애고 밑에서 확실하게")으로 차트 안 라벨은 전부 제거했다. */}
          {showPivot && levels?.pivot && (
            <>
              {levels.pivot.r2 > 0 && candles.some((c: any) => (c.highPrice || c.closePrice) >= levels.pivot.r1 * 0.98) && (
                <ReferenceLine y={levels.pivot.r2} stroke="#f97316" strokeWidth={1.5} />
              )}
              <ReferenceLine
                y={levels.pivot.r1}
                stroke="#ef4444"
                strokeWidth={1.5}
                strokeDasharray={isR1Flipped ? '4 2' : undefined}
              />
              <ReferenceLine y={levels.pivot.s1} stroke="#3b82f6" strokeWidth={1.5} />
            </>
          )}
          {activeSwingLow && (
            <ReferenceLine y={activeSwingLow.price} stroke="#06b6d4" strokeWidth={1.5} strokeDasharray="4 2" />
          )}
          {showFibo && levels?.fibonacci && (
            <>
              <ReferenceLine y={levels.fibonacci.fibo382} stroke="#10b981" strokeWidth={1.5} />
              <ReferenceLine y={levels.fibonacci.fibo500} stroke="#a855f7" strokeWidth={1.5} />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* 🚨 [버그 수정] Recharts 3.x는 onClick 콜백 시그니처가 (activePayload 등을 넘겨주던 2.x와 달리)
          activeIndex/activeCoordinate 중심의 완전히 다른 내부 Redux 이벤트 체계로 바뀌었는데, 실제
          브라우저 터치/클릭으로 이 프로젝트에서 재현 테스트해보니 신뢰도 있게 안 뜨는 경우가 있었다
          (node_modules/recharts/es6/chart/RechartsWrapper.js 실사용 코드로 확인). Recharts 내부에
          기대지 않고, 캔들 영역 위에 순수 HTML 오버레이를 얹어 탭 위치→캔들 인덱스를 직접 계산한다 -
          일반 DOM 클릭이라 확실하게 동작한다. */}
      <div
        className="absolute left-[52px] right-[10px] top-0 bottom-0 cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = e.clientX - rect.left;
          const idx = Math.round((relX / rect.width) * (candles.length - 1));
          const clamped = Math.max(0, Math.min(candles.length - 1, idx));
          if (candles[clamped]) {
            setSelectedCandle(candles[clamped]);
            setTapPos({ x: e.clientX, y: e.clientY });
          }
        }}
      />

      {/* 매물대 반투명 오버레이 - 일간 차트(MobileStockDetailChart.tsx)와 동일 패턴 */}
      {showVolumeProfile && volumeProfileBins.length > 0 && (
        <div className="absolute left-[52px] right-[10px] top-2 bottom-0 pointer-events-none">
          <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
            {volumeProfileBins.map((bin, i) => {
              const yHigh = PRICE_TOP_PADDING + (1 - (bin.priceHigh - minPrice) / (maxPrice - minPrice)) * PRICE_PLOT_HEIGHT;
              const yLow = PRICE_TOP_PADDING + (1 - (bin.priceLow - minPrice) / (maxPrice - minPrice)) * PRICE_PLOT_HEIGHT;
              const barHeight = Math.max(1, yLow - yHigh - 1);
              const maxBarWidthPct = 32;
              const widthPct = bin.ratio * maxBarWidthPct;
              if (widthPct <= 0) return null;
              return (
                <rect key={`vp3m-bin-${i}`} x={`${100 - widthPct}%`} y={yHigh} width={`${widthPct}%`} height={barHeight} fill={bin.isPoc ? '#f43f5e' : '#64748b'} opacity={bin.isPoc ? 0.55 : 0.25} rx={1} />
              );
            })}
          </svg>
        </div>
      )}
      </div>

      {/* 거래량 - 캔들 차트와 동일한 chartWidth 컨테이너 안에 있어야 가로 스크롤 시 x축이 어긋나지 않는다 */}
      <div className="mt-1">
        <ResponsiveContainer width="100%" height={70}>
          <ComposedChart
            data={candles}
            margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
          >
            <XAxis dataKey="time" stroke={axisColor} tick={{ fontSize: 8 }} interval="preserveStartEnd" />
            <YAxis stroke={axisColor} tickFormatter={formatYVol} tick={{ fontSize: 8 }} width={52} />
            {selectedCandle && <ReferenceLine x={selectedCandle.time} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />}
            <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]}>
              {candles.map((c, i) => (
                <Cell key={`vol3m-${i}`} fill={c.closePrice >= (c.openPrice ?? c.closePrice) ? '#ef4444' : '#3b82f6'} fillOpacity={0.6} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      </div>
      </div>
      </div>

      {/* 🚨 [사용자 요청] 차트 오른쪽 텍스트 라벨을 전부 없앤 대신, 그려지는 모든 선을 빠짐없이 여기
          범례에서 "무슨 선인지" 확실하게 안내한다 - 예전엔 R2/S1이 아예 빠져 있어서 그 두 선은 색만
          보고는 정체를 알 수 없었다. 각 항목의 선 색깔/굵기/점선 패턴을 위 ReferenceLine과 정확히 맞춘다. */}
      {(showVWAP || (showPivot && levels?.pivot) || (showFibo && levels?.fibonacci) || activeSwingLow) && (
        <div className="flex items-center justify-center gap-x-2.5 gap-y-1 pt-1.5 pb-0.5 text-[9px] font-semibold text-slate-600 dark:text-slate-300 flex-wrap">
          {showVWAP && (
            <>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#6366f1" strokeWidth="1.5" /></svg><span style={{ color: '#6366f1' }}>VWAP</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#2F9D27" strokeWidth="1.5" strokeDasharray="6 3" /></svg><span style={{ color: '#2F9D27' }}>±1σ</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#8FCB89" strokeWidth="1" strokeDasharray="3 3" /></svg><span style={{ color: '#8FCB89' }}>±2σ</span></div>
            </>
          )}
          {showPivot && levels?.pivot && (
            <>
              {levels.pivot.r2 > 0 && candles.some((c: any) => (c.highPrice || c.closePrice) >= levels.pivot!.r1 * 0.98) && (
                <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#f97316" strokeWidth="1.5" /></svg><span style={{ color: '#f97316' }}>R2 신고가</span></div>
              )}
              <div className="flex items-center gap-1">
                <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#ef4444" strokeWidth="1.5" strokeDasharray={isR1Flipped ? '3 2' : undefined} /></svg>
                <span className={isR1Flipped ? 'text-red-600 dark:text-red-400 font-bold' : ''} style={isR1Flipped ? undefined : { color: '#ef4444' }}>{isR1Flipped ? '지지전환(R1)' : 'R1 익절'}</span>
              </div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#3b82f6" strokeWidth="1.5" /></svg><span style={{ color: '#3b82f6' }}>S1 지지</span></div>
            </>
          )}
          {activeSwingLow && (
            <div className="flex items-center gap-1">
              <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#06b6d4" strokeWidth="1.5" strokeDasharray="4 2" /></svg>
              <span className="text-cyan-600 dark:text-cyan-400 font-bold">단기지지</span>
            </div>
          )}
          {showFibo && levels?.fibonacci && (
            <>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#10b981" strokeWidth="1.5" /></svg><span style={{ color: '#10b981' }}>38.2%매수</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#a855f7" strokeWidth="1.5" /></svg><span style={{ color: '#a855f7' }}>50%손절</span></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
