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
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { IntradayChartResponse } from '@/lib/types';
import { useTheme } from '@/providers/ThemeProvider';
import { PRICE_CHART_CONFIG, CandlestickBar, CustomCandleTooltip } from '@/components/chart/CandlestickPrimitives';

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

// MobileStockDetailChart.tsx가 일간 탭이 열리는 즉시 이 함수로 prefetchQuery를 걸어 3분봉을
// 백그라운드에서 미리 당겨둔다(사용자 요청: "일간봉 불러올때 3분봉 같이 불러올수는 없는거야?") - 그래서
// export한다. queryKey(['m-intraday3m', symbol])를 여기 useQuery와 반드시 동일하게 맞춰야 캐시가
// 재사용된다.
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

  if (isLoading) {
    return <div className="py-10 text-center text-slate-400 text-xs">3분봉 데이터를 불러오는 중입니다...</div>;
  }
  if (candles.length === 0) {
    return <div className="py-10 text-center text-slate-400 text-xs">표시할 3분봉 데이터가 없습니다.</div>;
  }

  return (
    <div>
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

      {/* 캔들스틱 + 매물대 오버레이 */}
      {/* 🚨 [버그 수정] 피봇/피보나치 ReferenceLine 라벨(position="right")이 PRICE_CHART_CONFIG의 공용
          margin(right: 15px)만으로는 375px 화면에서 텍스트가 잘려나갔다(사용자 지적으로 실측 확인 -
          "38.2%매수" 등이 "38"까지만 보임). 이 차트만 오른쪽 여백을 넓힌 별도 margin을 쓴다(일간 차트/
          지수 차트가 공유하는 PRICE_CHART_CONFIG.margin 자체는 건드리지 않음 - 그쪽엔 영향 없음). */}
      <div className="relative">
      <ResponsiveContainer width="100%" height={PRICE_CHART_CONFIG.containerHeight}>
        <ComposedChart data={candles} margin={{ ...PRICE_CHART_CONFIG.margin, right: 46 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
          <XAxis dataKey="time" hide={true} />
          <YAxis stroke={axisColor} tickFormatter={formatYPrice} tick={{ fontSize: 9 }} width={52} domain={priceDomain} ticks={priceTicks} allowDataOverflow={true} />
          <Tooltip content={<CustomCandleTooltip />} cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '3 3' }} />
          <Bar dataKey="closePrice" name="캔들스틱" shape={(props: any) => <CandlestickBar {...props} minPrice={minPrice} maxPrice={maxPrice} topPadding={PRICE_CHART_CONFIG.margin.top} plotHeight={PRICE_CHART_CONFIG.plotHeight} />} isAnimationActive={false} />
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
          {/* 피봇 수평선 - R2(신고가)는 주가가 R1의 98% 이상 근접/돌파했을 때만(데스크톱과 동일 조건) */}
          {showPivot && levels?.pivot && (
            <>
              {levels.pivot.r2 > 0 && candles.some((c: any) => (c.highPrice || c.closePrice) >= levels.pivot.r1 * 0.98) && (
                <ReferenceLine y={levels.pivot.r2} stroke="#f97316" strokeWidth={1.5} label={{ value: 'R2', fill: '#f97316', fontSize: 9, position: 'right' }} />
              )}
              <ReferenceLine
                y={levels.pivot.r1}
                stroke="#ef4444"
                strokeWidth={1.5}
                strokeDasharray={isR1Flipped ? '4 2' : undefined}
                label={{ value: isR1Flipped ? '지지전환' : 'R1익절', fill: '#ef4444', fontSize: 9, position: 'right' }}
              />
              <ReferenceLine y={levels.pivot.s1} stroke="#3b82f6" strokeWidth={1.5} label={{ value: 'S1지지', fill: '#3b82f6', fontSize: 9, position: 'right' }} />
            </>
          )}
          {activeSwingLow && (
            <ReferenceLine y={activeSwingLow.price} stroke="#06b6d4" strokeWidth={1.5} strokeDasharray="4 2" label={{ value: '단기지지', fill: '#06b6d4', fontSize: 9, position: 'right', fontWeight: 'bold' }} />
          )}
          {showFibo && levels?.fibonacci && (
            <>
              <ReferenceLine y={levels.fibonacci.fibo382} stroke="#10b981" strokeWidth={1.5} label={{ value: '38.2%매수', fill: '#10b981', fontSize: 9, position: 'right' }} />
              <ReferenceLine y={levels.fibonacci.fibo500} stroke="#a855f7" strokeWidth={1.5} label={{ value: '50%손절', fill: '#a855f7', fontSize: 9, position: 'right' }} />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* 매물대 반투명 오버레이 - 일간 차트(MobileStockDetailChart.tsx)와 동일 패턴 */}
      {showVolumeProfile && volumeProfileBins.length > 0 && (
        <div className="absolute left-[52px] right-[46px] top-2 bottom-0 pointer-events-none">
          <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
            {volumeProfileBins.map((bin, i) => {
              const topPadding = PRICE_CHART_CONFIG.margin.top;
              const plotHeight = PRICE_CHART_CONFIG.plotHeight;
              const yHigh = topPadding + (1 - (bin.priceHigh - minPrice) / (maxPrice - minPrice)) * plotHeight;
              const yLow = topPadding + (1 - (bin.priceLow - minPrice) / (maxPrice - minPrice)) * plotHeight;
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

      {/* 범례 (VWAP/피봇/피보나치/스윙로우 색상 안내 - 차트 안이 아니라 바깥에 표시) */}
      {(showVWAP || (showPivot && levels?.pivot) || (showFibo && levels?.fibonacci) || activeSwingLow) && (
        <div className="flex items-center justify-center gap-2.5 pt-1 pb-0.5 text-[9px] font-semibold text-slate-600 dark:text-slate-300 flex-wrap">
          {showVWAP && (
            <>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#6366f1" strokeWidth="1.5" /></svg><span style={{ color: '#6366f1' }}>VWAP</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#2F9D27" strokeWidth="1.5" strokeDasharray="6 3" /></svg><span style={{ color: '#2F9D27' }}>±1σ</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#8FCB89" strokeWidth="1" strokeDasharray="3 3" /></svg><span style={{ color: '#8FCB89' }}>±2σ</span></div>
            </>
          )}
          {showPivot && levels?.pivot && (
            <div className="flex items-center gap-1">
              {isR1Flipped ? (
                <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
              ) : (
                <span className="w-2.5 h-1.5 bg-red-500 inline-block rounded-xs" />
              )}
              <span className={isR1Flipped ? 'text-red-600 dark:text-red-400 font-bold' : ''}>{isR1Flipped ? '지지전환(R1)' : 'R1 익절'}</span>
            </div>
          )}
          {activeSwingLow && (
            <div className="flex items-center gap-1">
              <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#06b6d4" strokeWidth="1.5" strokeDasharray="4 2" /></svg>
              <span className="text-cyan-600 dark:text-cyan-400 font-bold">단기지지({activeSwingLow.price.toLocaleString()})</span>
            </div>
          )}
          {showFibo && levels?.fibonacci && (
            <div className="flex items-center gap-1">
              <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#10b981" strokeWidth="1.5" /></svg>
              <span style={{ color: '#10b981' }}>38.2%매수 · <span style={{ color: '#a855f7' }}>50%손절</span></span>
            </div>
          )}
        </div>
      )}

      {/* 거래량 */}
      <div className="mt-1">
        <ResponsiveContainer width="100%" height={70}>
          <ComposedChart data={candles} margin={{ top: 5, right: 15, left: -10, bottom: 0 }}>
            <XAxis dataKey="time" stroke={axisColor} tick={{ fontSize: 8 }} interval="preserveStartEnd" />
            <YAxis stroke={axisColor} tickFormatter={formatYVol} tick={{ fontSize: 8 }} width={52} />
            <Tooltip formatter={(v: any) => [Number(v).toLocaleString(), '거래량']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
            <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]}>
              {candles.map((c, i) => (
                <Cell key={`vol3m-${i}`} fill={c.closePrice >= (c.openPrice ?? c.closePrice) ? '#ef4444' : '#3b82f6'} fillOpacity={0.6} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
