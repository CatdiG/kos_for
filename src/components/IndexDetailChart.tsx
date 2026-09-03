'use client';

// KOSPI/KOSDAQ 지수 일봉 차트 - 종목 상세 차트(RankingStockDetailChart.tsx)의 "일간" 탭과 동일한 시각
// 구성(캔들스틱+MA5/20/60+매물대+거래량)을 재사용하되, 지수에는 KIS API상 외국인/기관/프로그램 순매수
// 개념이 없어(실측으로 확인됨 - AGENTS.md 수칙 1-3: 없는 데이터를 가짜로 채우지 않음) 그 서브플롯만
// "일별 거래량"으로 대체한다. 캔들 렌더링/툴팁/추세배지 로직은 CandlestickPrimitives.tsx 공통 모듈을
// 그대로 재사용해 종목 차트와 중복 구현하지 않는다(수칙 1-6).

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
import { IndexTrendResponse, TrendPeriod } from '@/lib/types';
import { useTheme } from '@/providers/ThemeProvider';
import { PRICE_CHART_CONFIG, CandlestickBar, CustomCandleTooltip, getTrendBadgeInfo } from '@/components/chart/CandlestickPrimitives';
import { TrendingUp, TrendingDown, X, RefreshCw } from 'lucide-react';

interface IndexDetailChartProps {
  market: 'KOSPI' | 'KOSDAQ';
  onClose?: () => void;
}

async function fetchIndexTrend(market: 'KOSPI' | 'KOSDAQ', period: TrendPeriod): Promise<IndexTrendResponse> {
  const res = await fetch(`/api/stock/index-trend?market=${market}&period=${period}&t=${Date.now()}`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '지수 데이터를 불러오는데 실패했습니다.');
  }
  return res.json();
}

/**
 * 지수 포인트(소수점) 값 기준 "보기 좋은" Y축 도메인/눈금 산출 - 종목의 KRX 호가단위 기반 축과 달리
 * 지수는 몇백~몇천 포인트 단위로 움직이므로 별도의 nice-number 라운딩을 쓴다.
 */
function calculateIndexPriceAxis(minRaw: number, maxRaw: number, targetTicks = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0 || maxRaw <= minRaw) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100] as [number, number], priceTicks: [0, 20, 40, 60, 80, 100] };
  }
  const range = maxRaw - minRaw;
  const pad = Math.max(range * 0.08, 2);
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
  for (let p = startP; p <= endP + step * 0.01; p += step) ticks.push(Math.round(p * 100) / 100);
  return { minPrice: startP, maxPrice: endP, priceDomain: [startP, endP] as [number, number], priceTicks: ticks };
}

export default function IndexDetailChart({ market, onClose }: IndexDetailChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const axisColor = isDark ? '#94a3b8' : '#475569';

  const [period, setPeriod] = useState<TrendPeriod>('60d');
  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(true);
  const [showVolumeProfile, setShowVolumeProfile] = useState(true);
  const [showDisparate, setShowDisparate] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<IndexTrendResponse>({
    queryKey: ['indexTrend', market, period],
    queryFn: () => fetchIndexTrend(market, period),
  });

  const rawTrend = data?.trend || [];

  // MA5/20/60 + 20일 전저점(2차 지지선) + 추세배지 계산 (종목 일간 차트와 동일한 방식)
  const displayTrend = React.useMemo(() => {
    return rawTrend.map((d, idx, arr) => {
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = slice5.reduce((acc, x) => acc + x.closePrice, 0) / slice5.length;

      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = slice20.reduce((acc, x) => acc + x.closePrice, 0) / slice20.length;

      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.reduce((acc, x) => acc + x.closePrice, 0) / slice60.length;

      const recentLow = Math.min(...slice20.map((x) => (x.lowPrice > 0 ? x.lowPrice : x.closePrice)));

      const volumeRatio = idx > 0 && arr[idx - 1].volume > 0 ? d.volume / arr[idx - 1].volume : null;
      const { badge } = getTrendBadgeInfo(d.closePrice, ma5, idx >= 19 ? ma20 : null, idx >= 59 ? ma60 : null, volumeRatio);

      return { ...d, ma5, ma20, ma60, recentLow, trendStatus: badge };
    });
  }, [rawTrend]);

  // 100%-Baseline 이격도 & 4대 핵심 가격선 - 종목 일간 차트(RankingStockDetailChart.tsx)와 동일한 공식.
  // (지수는 KRX 호가단위 개념이 없어 roundToKrxTick 대신 포인트 0.01 단위로 반올림한다.)
  const roundIndexPt = (v: number) => Math.round(v * 100) / 100;
  const disparateInfo = React.useMemo(() => {
    if (displayTrend.length === 0) {
      return { disparate20: 100, disparate60: 100, overbought20Price: 0, oversold20Price: 0, overbought60Price: 0, oversold60Price: 0, support1Price: 0, recentLowPrice: 0 };
    }
    const last = displayTrend[displayTrend.length - 1];
    const currentP = last.closePrice;
    const ma20 = last.ma20;
    const ma60 = last.ma60;

    const disparate20 = ma20 > 0 ? Number(((currentP / ma20) * 100).toFixed(1)) : 100;
    const disparate60 = ma60 > 0 ? Number(((currentP / ma60) * 100).toFixed(1)) : 100;

    return {
      disparate20,
      disparate60,
      overbought20Price: roundIndexPt(ma20 * 1.05),
      oversold20Price: roundIndexPt(ma20 * 0.95),
      overbought60Price: roundIndexPt(ma60 * 1.10),
      oversold60Price: roundIndexPt(ma60 * 0.90),
      support1Price: roundIndexPt(ma20),
      recentLowPrice: last.recentLow,
    };
  }, [displayTrend]);

  // 매물대(가격대별 누적 거래량) - 종목 일간 차트와 동일한 로직(대표가에 그날 거래량 배정)
  const { minPrice, maxPrice, priceDomain, priceTicks } = React.useMemo(() => {
    if (displayTrend.length === 0) return calculateIndexPriceAxis(0, 100);
    const highs = displayTrend.map((d) => d.highPrice || d.closePrice);
    const lows = displayTrend.map((d) => d.lowPrice || d.closePrice);
    const ma20s = displayTrend.map((d) => d.ma20).filter((v) => v > 0);
    const ma60s = displayTrend.map((d) => d.ma60).filter((v) => v > 0);
    const disparateVals = showDisparate
      ? [disparateInfo.overbought20Price, disparateInfo.oversold20Price, disparateInfo.overbought60Price, disparateInfo.oversold60Price, disparateInfo.recentLowPrice].filter((v) => v > 0)
      : [];
    const allVals = [...highs, ...lows, ...(showMA20 ? ma20s : []), ...(showMA60 ? ma60s : []), ...disparateVals];
    return calculateIndexPriceAxis(Math.min(...allVals), Math.max(...allVals), 6);
  }, [displayTrend, showMA20, showMA60, showDisparate, disparateInfo]);

  const volumeProfileBins = React.useMemo(() => {
    if (!showVolumeProfile || displayTrend.length === 0 || minPrice <= 0 || maxPrice <= minPrice) return [];
    const BIN_COUNT = 24;
    const binSize = (maxPrice - minPrice) / BIN_COUNT;
    const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({ priceLow: minPrice + i * binSize, priceHigh: minPrice + (i + 1) * binSize, volume: 0 }));
    displayTrend.forEach((d) => {
      const vol = d.volume || 0;
      if (vol <= 0) return;
      const typicalPrice = (d.highPrice + d.lowPrice + d.closePrice) / 3;
      const idx = Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((typicalPrice - minPrice) / binSize)));
      bins[idx].volume += vol;
    });
    const maxBinVolume = Math.max(1, ...bins.map((b) => b.volume));
    let pocIdx = 0;
    bins.forEach((b, i) => { if (b.volume > bins[pocIdx].volume) pocIdx = i; });
    return bins.map((b, i) => ({ ...b, ratio: b.volume / maxBinVolume, isPoc: i === pocIdx && b.volume > 0 }));
  }, [showVolumeProfile, displayTrend, minPrice, maxPrice]);

  const formatYPrice = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const formatYVol = (v: number) => (v >= 100000000 ? `${Math.round(v / 100000000)}억` : v >= 10000 ? `${Math.round(v / 10000)}만` : v.toLocaleString());

  const indexInfo = data?.indexInfo;
  const isUp = (indexInfo?.change || 0) >= 0;

  return (
    <div className="relative bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-2xl p-3 sm:p-4 shadow-xl transition-all duration-300">
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] text-slate-500 dark:text-[#787b86] transition"
          title="닫기"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {/* 헤더: 현재지수 + 등락 + 등락종목수 + 거래대금 */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 pr-8">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{indexInfo?.name || (market === 'KOSPI' ? '코스피' : '코스닥')}</h2>
          {indexInfo && (
            <>
              <span className="text-xl font-bold font-mono text-slate-900 dark:text-white">{indexInfo.currentPrice.toLocaleString()}</span>
              <span className={`flex items-center gap-1 text-sm font-semibold font-mono ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
                {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {isUp ? '+' : ''}{indexInfo.change.toFixed(2)} ({isUp ? '+' : ''}{indexInfo.changeRate.toFixed(2)}%)
              </span>
            </>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] text-slate-500 dark:text-[#787b86] transition disabled:opacity-50"
            title="새로고침"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin text-red-600' : ''}`} />
          </button>
        </div>
        {indexInfo && (
          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500 dark:text-[#787b86]">
            <span className="text-red-500">상승 {indexInfo.advancingCount}</span>
            <span className="text-slate-400">보합 {indexInfo.unchangedCount}</span>
            <span className="text-blue-500">하락 {indexInfo.decliningCount}</span>
            <span className="pl-2 border-l border-slate-200 dark:border-[#2a2e39]">거래대금 {(indexInfo.tradingValueEok || 0).toLocaleString()}억</span>
          </div>
        )}
      </div>

      {isError && (
        <div className="mb-3 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs">
          {(error as Error)?.message || '지수 데이터를 불러오지 못했습니다.'}
        </div>
      )}

      {/* 100%-Baseline 이격도 & 4대 핵심 가격선 헤더 카드 (종목 일간 차트와 동일한 산식) */}
      {displayTrend.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <div className="flex flex-col gap-1.5 bg-slate-50/90 dark:bg-[#161a25]/90 p-2.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39] shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] pb-1 border-b border-slate-100 dark:border-slate-800/80">
              <div className="flex items-center gap-1.5 font-mono">
                <span className="font-bold text-amber-600 dark:text-amber-400 text-xs">📊 20일선 이격도:</span>
                <strong className={`font-black text-[14px] ${disparateInfo.disparate20 >= 105 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>
                  {disparateInfo.disparate20}%
                </strong>
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                  {disparateInfo.disparate20 >= 105 ? '(⚠️ 과열)' : disparateInfo.disparate20 <= 95 ? '(🔵 반등)' : ''}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 text-[11px] pt-1 border-t border-slate-100 dark:border-slate-800/60 whitespace-nowrap">
              <div className="text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80">🔴 과열가: <strong className="font-mono">{disparateInfo.overbought20Price > 0 ? disparateInfo.overbought20Price.toLocaleString() : '-'}</strong></div>
              <div className="text-center text-orange-600 dark:text-orange-400 border-r border-slate-200/80 dark:border-slate-800/80">🟠 1차지지: <strong className="font-mono">{disparateInfo.support1Price > 0 ? disparateInfo.support1Price.toLocaleString() : '-'}</strong></div>
              <div className="text-center text-purple-600 dark:text-purple-400 border-r border-slate-200/80 dark:border-slate-800/80">🟣 2차지지: <strong className="font-mono">{disparateInfo.recentLowPrice > 0 ? disparateInfo.recentLowPrice.toLocaleString() : '-'}</strong></div>
              <div className="text-center text-blue-600 dark:text-blue-400">🔵 침체가: <strong className="font-mono">{disparateInfo.oversold20Price > 0 ? disparateInfo.oversold20Price.toLocaleString() : '-'}</strong></div>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 bg-slate-50/90 dark:bg-[#161a25]/90 p-2.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39] shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] pb-1 border-b border-slate-100 dark:border-slate-800/80">
              <div className="flex items-center gap-1.5 font-mono">
                <span className="font-bold text-cyan-600 dark:text-cyan-400 text-xs">📈 60일선 이격도:</span>
                <strong className={`font-black text-[14px] ${disparateInfo.disparate60 <= 90 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-800 dark:text-slate-100'}`}>
                  {disparateInfo.disparate60}%
                </strong>
                <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                  {disparateInfo.disparate60 >= 110 ? '(⚠️ 과열)' : disparateInfo.disparate60 <= 90 ? '(🔵 반등)' : ''}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-0 text-[11px] pt-1 border-t border-slate-100 dark:border-slate-800/60 whitespace-nowrap">
              <div className="text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80">🔴 110% 과열가: <strong className="font-mono">{disparateInfo.overbought60Price > 0 ? disparateInfo.overbought60Price.toLocaleString() : '-'}</strong></div>
              <div className="text-center text-blue-600 dark:text-blue-400">🔵 90% 침체가: <strong className="font-mono">{disparateInfo.oversold60Price > 0 ? disparateInfo.oversold60Price.toLocaleString() : '-'}</strong></div>
            </div>
          </div>
        </div>
      )}

      {/* 기간 & 지표 토글 */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <div className="flex items-center bg-slate-100 dark:bg-[#1e222d] p-1 rounded-lg text-xs">
          {(['5d', '20d', '60d'] as TrendPeriod[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2.5 py-1 rounded-md font-bold transition ${period === p ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-[#787b86]'}`}
            >
              {p === '5d' ? '5일' : p === '20d' ? '20일' : '60일'}
            </button>
          ))}
        </div>
        {[
          { key: 'ma5', label: 'MA5', active: showMA5, setter: setShowMA5, color: 'text-amber-500 border-amber-500/40' },
          { key: 'ma20', label: 'MA20', active: showMA20, setter: setShowMA20, color: 'text-purple-500 border-purple-500/40' },
          { key: 'ma60', label: 'MA60', active: showMA60, setter: setShowMA60, color: 'text-cyan-500 border-cyan-500/40' },
          { key: 'vp', label: '매물대', active: showVolumeProfile, setter: setShowVolumeProfile, color: 'text-slate-500 border-slate-400/40' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => t.setter((v) => !v)}
            className={`px-2.5 py-1 rounded-md text-xs font-bold border transition ${t.active ? `bg-white dark:bg-[#1e222d] ${t.color}` : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => {
            const next = !showDisparate;
            setShowDisparate(next);
            if (next) {
              setShowMA5(false);
              setShowMA20(false);
              setShowMA60(false);
            } else {
              setShowMA5(true);
              setShowMA20(true);
              setShowMA60(true);
            }
          }}
          className={`px-2.5 py-1 rounded-md text-xs font-bold border transition ${showDisparate ? 'bg-white dark:bg-[#1e222d] text-emerald-600 dark:text-emerald-400 border-emerald-500/40 ring-1 ring-emerald-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          이격도
        </button>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-slate-400 text-sm">지수 데이터를 불러오는 중입니다...</div>
      ) : displayTrend.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-sm">표시할 데이터가 없습니다.</div>
      ) : (
        <div className="grid grid-rows-[auto_auto] gap-2 border border-slate-100 dark:border-[#1e222d] rounded-xl overflow-hidden">
          {/* Top: 캔들스틱 + MA + 매물대 오버레이 */}
          <div className="p-2 relative">
            <ResponsiveContainer width="100%" height={PRICE_CHART_CONFIG.containerHeight}>
              <ComposedChart syncId="index-detail-chart" data={displayTrend} margin={PRICE_CHART_CONFIG.margin}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                <XAxis dataKey="formattedDate" hide={true} />
                <YAxis stroke={axisColor} tickFormatter={formatYPrice} tick={{ fontSize: 10 }} width={60} domain={priceDomain} ticks={priceTicks} />
                <Tooltip content={<CustomCandleTooltip priceLabel="pt" />} cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '3 3' }} />
                <Bar dataKey="closePrice" name="캔들스틱" shape={(props: any) => <CandlestickBar {...props} minPrice={minPrice} maxPrice={maxPrice} topPadding={PRICE_CHART_CONFIG.margin.top} plotHeight={PRICE_CHART_CONFIG.plotHeight} />} isAnimationActive={false} />
                {showMA5 && <Line type="linear" dataKey="ma5" name="5일 이동평균" stroke="#f59e0b" strokeWidth={1.8} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
                {showMA20 && <Line type="linear" dataKey="ma20" name="20일 이동평균" stroke="#a855f7" strokeWidth={2.0} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
                {showMA60 && <Line type="linear" dataKey="ma60" name="60일 이동평균" stroke="#06b6d4" strokeWidth={1.8} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
                {showDisparate && disparateInfo.overbought20Price > 0 && (
                  <ReferenceLine y={disparateInfo.overbought20Price} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 4" />
                )}
                {showDisparate && disparateInfo.support1Price > 0 && (
                  <ReferenceLine y={disparateInfo.support1Price} stroke="#f97316" strokeWidth={1.5} strokeDasharray="4 4" />
                )}
                {showDisparate && disparateInfo.recentLowPrice > 0 && (
                  <ReferenceLine y={disparateInfo.recentLowPrice} stroke="#a855f7" strokeWidth={1.5} strokeDasharray="4 4" />
                )}
                {showDisparate && disparateInfo.oversold20Price > 0 && (
                  <ReferenceLine y={disparateInfo.oversold20Price} stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 4" />
                )}
              </ComposedChart>
            </ResponsiveContainer>

            {/* 매물대 반투명 오버레이 */}
            {showVolumeProfile && volumeProfileBins.length > 0 && (
              <div className="absolute left-[62px] right-[15px] top-2 bottom-0 pointer-events-none">
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
                      <rect key={`vp-bin-${i}`} x={`${100 - widthPct}%`} y={yHigh} width={`${widthPct}%`} height={barHeight} fill={bin.isPoc ? '#f43f5e' : '#64748b'} opacity={bin.isPoc ? 0.55 : 0.25} rx={1} />
                    );
                  })}
                </svg>
              </div>
            )}
          </div>

          {/* Bottom: 일별 거래량 (지수는 수급 데이터가 없어 거래량으로 대체) */}
          <div className="p-2">
            <div className="text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">일별 거래량</div>
            <ResponsiveContainer width="100%" height={100}>
              <ComposedChart syncId="index-detail-chart" data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                <XAxis dataKey="formattedDate" stroke={axisColor} tick={{ fontSize: 9 }} />
                <YAxis stroke={axisColor} tickFormatter={formatYVol} tick={{ fontSize: 9 }} width={60} />
                <Tooltip
                  formatter={(v: any) => [Number(v).toLocaleString(), '거래량']}
                  contentStyle={{ fontSize: 11, borderRadius: 8 }}
                />
                <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]}>
                  {displayTrend.map((d, i) => (
                    <Cell key={`vol-${i}`} fill={d.closePrice >= d.openPrice ? '#ef4444' : '#3b82f6'} fillOpacity={0.6} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
