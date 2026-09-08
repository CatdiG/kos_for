'use client';

// 데스크톱 IndexDetailChart.tsx의 모바일판 - 코스피/코스닥 지수 캔들스틱+MA5/20/60+이격도(20/60일)+
// 매물대+거래량. 120일선은 데스크톱에서 이미 안정성 문제로 제거된 상태(KIS 지수 일봉 API가 100영업일씩만
// 내려줘 2페이지 페이지네이션이 필요했는데 종종 조용히 실패했음, 사용자 결정)라 모바일에도 만들지 않는다.
// 지수는 KIS API상 외국인/기관/프로그램 순매수 개념이 없어(실측 확인, 수칙 1-3) 신용정보 배지도 없다.
// 계산 로직/JSX는 데스크톱 IndexDetailChart.tsx를 그대로 이식하고 레이아웃만 모바일 폭에 맞춘다(수칙 1-6).

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
import MobileLoadingSpinner from './MobileLoadingSpinner';

interface MobileIndexDetailChartProps {
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

// IndexDetailChart.tsx의 calculateIndexPriceAxis와 동일한 nice-number 방식.
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

export default function MobileIndexDetailChart({ market, onClose }: MobileIndexDetailChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const axisColor = isDark ? '#94a3b8' : '#475569';

  const [period, setPeriod] = useState<TrendPeriod>('60d');
  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(false);
  const [showVolumeProfile, setShowVolumeProfile] = useState(true);
  const [showDisparate, setShowDisparate] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<IndexTrendResponse>({
    queryKey: ['indexTrend', market, period],
    queryFn: () => fetchIndexTrend(market, period),
  });

  const rawTrend = data?.trend || [];

  const fullTrendWithMA = React.useMemo(() => {
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

  const displayTrend = React.useMemo(() => {
    const limit = period === '5d' ? 5 : period === '20d' ? 20 : 60;
    return fullTrendWithMA.slice(-limit);
  }, [fullTrendWithMA, period]);

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

  const { minPrice, maxPrice, priceDomain, priceTicks } = React.useMemo(() => {
    if (displayTrend.length === 0) return calculateIndexPriceAxis(0, 100);
    const highs = displayTrend.map((d) => d.highPrice || d.closePrice);
    const lows = displayTrend.map((d) => d.lowPrice || d.closePrice);
    const ma20s = displayTrend.map((d) => d.ma20).filter((v) => v > 0);
    const ma60s = displayTrend.map((d) => d.ma60).filter((v) => v > 0);
    const disparateVals = showDisparate
      ? [
          disparateInfo.overbought20Price, disparateInfo.oversold20Price,
          disparateInfo.overbought60Price, disparateInfo.oversold60Price,
          disparateInfo.recentLowPrice,
        ].filter((v) => v > 0)
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
    <div className="relative w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-2.5">
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-2.5 right-2.5 z-10 p-1.5 rounded-lg bg-slate-100 dark:bg-[#1e222d] text-slate-500 dark:text-[#787b86]"
          title="닫기"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {/* 헤더: 현재지수 + 등락 + 등락종목수 + 거래대금 */}
      <div className="flex flex-col gap-1 mb-2 pr-8">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-base font-bold text-slate-900 dark:text-white">{indexInfo?.name || (market === 'KOSPI' ? '코스피' : '코스닥')}</h2>
          {indexInfo && (
            <>
              <span className="text-lg font-bold font-mono text-slate-900 dark:text-white">{indexInfo.currentPrice.toLocaleString()}</span>
              <span className={`flex items-center gap-1 text-xs font-semibold font-mono ${isUp ? 'text-red-600 dark:text-red-500' : 'text-blue-600 dark:text-blue-500'}`}>
                {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {isUp ? '+' : ''}{indexInfo.change.toFixed(2)} ({isUp ? '+' : ''}{indexInfo.changeRate.toFixed(2)}%)
              </span>
              <button onClick={() => refetch()} disabled={isFetching} className="p-1 rounded-lg bg-slate-100 dark:bg-[#1e222d] text-slate-500 dark:text-[#787b86]">
                <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin text-red-600' : ''}`} />
              </button>
            </>
          )}
        </div>
        {indexInfo && (
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 dark:text-[#787b86]">
            <span className="text-red-500">상승 {indexInfo.advancingCount}</span>
            <span className="text-slate-400">보합 {indexInfo.unchangedCount}</span>
            <span className="text-blue-500">하락 {indexInfo.decliningCount}</span>
            <span className="pl-1.5 border-l border-slate-200 dark:border-[#2a2e39]">거래대금 {(indexInfo.tradingValueEok || 0).toLocaleString()}억</span>
          </div>
        )}
      </div>

      {isError && (
        <div className="mb-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px]">
          {(error as Error)?.message || '지수 데이터를 불러오지 못했습니다.'}
        </div>
      )}

      {/* 이격도 헤더 카드 (20일 / 60일) */}
      {showDisparate && displayTrend.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-2">
          <div className="flex flex-col gap-1 bg-slate-50/90 dark:bg-[#161a25]/90 p-2 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]">
            <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
              <span className="font-bold text-amber-600 dark:text-amber-400">20일:</span>
              <strong className={`font-black text-[13px] ${disparateInfo.disparate20 >= 105 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>{disparateInfo.disparate20}%</strong>
              <span className="text-[10px] text-slate-500">과열가 {disparateInfo.overbought20Price.toLocaleString()} · 1차지지 {disparateInfo.support1Price.toLocaleString()} · 침체가 {disparateInfo.oversold20Price.toLocaleString()}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 bg-slate-50/90 dark:bg-[#161a25]/90 p-2 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]">
            <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
              <span className="font-bold text-cyan-600 dark:text-cyan-400">60일:</span>
              <strong className={`font-black text-[13px] ${disparateInfo.disparate60 <= 90 ? 'text-blue-600 dark:text-blue-400' : disparateInfo.disparate60 >= 110 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>{disparateInfo.disparate60}%</strong>
              <span className="text-[10px] text-slate-500">과열가 {disparateInfo.overbought60Price.toLocaleString()} · 침체가 {disparateInfo.oversold60Price.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}

      {/* 기간 & 지표 토글 */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
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
            className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${t.active ? `bg-white dark:bg-[#1e222d] ${t.color}` : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => {
            const next = !showDisparate;
            setShowDisparate(next);
            if (next) { setShowMA5(false); setShowMA20(false); setShowMA60(false); }
            else { setShowMA5(true); setShowMA20(true); setShowMA60(true); }
          }}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showDisparate ? 'bg-white dark:bg-[#1e222d] text-emerald-600 dark:text-emerald-400 border-emerald-500/40 ring-1 ring-emerald-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          이격도
        </button>
      </div>

      {isLoading ? (
        <MobileLoadingSpinner label="지수 데이터를 불러오는 중입니다..." />
      ) : displayTrend.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-xs">표시할 데이터가 없습니다.</div>
      ) : (
        <>
          <div className="relative">
            <ResponsiveContainer width="100%" height={PRICE_CHART_CONFIG.containerHeight}>
              <ComposedChart data={displayTrend} margin={PRICE_CHART_CONFIG.margin}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                <XAxis dataKey="formattedDate" hide={true} />
                <YAxis stroke={axisColor} tickFormatter={formatYPrice} tick={{ fontSize: 9 }} width={52} domain={priceDomain} ticks={priceTicks} allowDataOverflow={true} />
                <Tooltip content={<CustomCandleTooltip priceLabel="pt" />} cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '3 3' }} />
                <Bar dataKey="closePrice" name="캔들스틱" shape={(props: any) => <CandlestickBar {...props} minPrice={minPrice} maxPrice={maxPrice} topPadding={PRICE_CHART_CONFIG.margin.top} plotHeight={PRICE_CHART_CONFIG.plotHeight} />} isAnimationActive={false} />
                {showMA5 && <Line type="linear" dataKey="ma5" name="5일 이동평균" stroke="#f59e0b" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
                {showMA20 && <Line type="linear" dataKey="ma20" name="20일 이동평균" stroke="#a855f7" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
                {showMA60 && <Line type="linear" dataKey="ma60" name="60일 이동평균" stroke="#06b6d4" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
                {showDisparate && disparateInfo.overbought20Price > 0 && <ReferenceLine y={disparateInfo.overbought20Price} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 4" />}
                {showDisparate && disparateInfo.support1Price > 0 && <ReferenceLine y={disparateInfo.support1Price} stroke="#f97316" strokeWidth={1.5} strokeDasharray="4 4" />}
                {showDisparate && disparateInfo.recentLowPrice > 0 && <ReferenceLine y={disparateInfo.recentLowPrice} stroke="#a855f7" strokeWidth={1.5} strokeDasharray="4 4" />}
                {showDisparate && disparateInfo.oversold20Price > 0 && <ReferenceLine y={disparateInfo.oversold20Price} stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 4" />}
                {showDisparate && disparateInfo.overbought60Price > 0 && <ReferenceLine y={disparateInfo.overbought60Price} stroke="#10b981" strokeWidth={1.5} strokeDasharray="4 2" />}
                {showDisparate && disparateInfo.oversold60Price > 0 && <ReferenceLine y={disparateInfo.oversold60Price} stroke="#10b981" strokeWidth={1.5} strokeDasharray="1 3" />}
              </ComposedChart>
            </ResponsiveContainer>

            {showVolumeProfile && volumeProfileBins.length > 0 && (
              <div className="absolute left-[52px] right-[15px] top-2 bottom-0 pointer-events-none">
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

          {showDisparate && (
            <div className="flex items-center justify-center gap-2.5 pt-1.5 pb-0.5 text-[9px] font-semibold text-slate-600 dark:text-slate-300 flex-wrap">
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4 4" /></svg><span>20일 과열</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 4" /></svg><span>20일 침체</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 2" /></svg><span style={{ color: '#10b981' }}>60일 과열</span></div>
              <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#10b981" strokeWidth="1.5" strokeDasharray="1 3" /></svg><span style={{ color: '#10b981' }}>60일 침체</span></div>
            </div>
          )}

          <div className="mt-1">
            <div className="text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">일별 거래량</div>
            <ResponsiveContainer width="100%" height={70}>
              <ComposedChart data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }}>
                <XAxis dataKey="formattedDate" stroke={axisColor} tick={{ fontSize: 8 }} />
                <YAxis stroke={axisColor} tickFormatter={formatYVol} tick={{ fontSize: 8 }} width={52} />
                <Tooltip formatter={(v: any) => [Number(v).toLocaleString(), '거래량']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]}>
                  {displayTrend.map((d, i) => (
                    <Cell key={`vol-${i}`} fill={d.closePrice >= d.openPrice ? '#ef4444' : '#3b82f6'} fillOpacity={0.6} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
