'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { InvestorTrendResponse, TrendPeriod } from '@/lib/types';
import { getStockName, resolveStockPriceAndChange, computeUnifiedStatusBadge } from '@/lib/mockData';
import { TrendingUp, TrendingDown, Calendar, Clock, Activity, RefreshCw, AlertCircle } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';

interface RankingStockDetailChartProps {
  symbol: string;
  rank?: number;
  rankingTypeLabel?: string;
  data?: InvestorTrendResponse;
  isLoading?: boolean;
  period?: TrendPeriod;
  onPeriodChange?: (period: TrendPeriod) => void;
}

async function fetchTrend(symbol: string, period: TrendPeriod): Promise<InvestorTrendResponse> {
  const res = await fetch(`/api/stock/investor-trend?symbol=${symbol}&period=${period}&t=${Date.now()}`);
  if (!res.ok) {
    throw new Error('종목 시세 데이터를 불러오는데 실패했습니다.');
  }
  return res.json();
}

/**
 * 전 종목 통일 이동평균 추세 및 이격도 배지 산출 (Single Source of Truth)
 */
function getTrendBadgeInfo(closePrice: number, ma5: number | null, ma20: number | null, ma60: number | null) {
  const res = computeUnifiedStatusBadge(closePrice, ma5, ma20, ma60);
  return { badge: res.shortBadge, badgeStyle: res.badgeStyle };
}

interface CandlestickProps {
  x?: number;
  width?: number;
  openPrice?: number;
  closePrice?: number;
  highPrice?: number;
  lowPrice?: number;
  yAxis?: any;
}

// Unified Single Source of Truth for Top Price Chart Subplot Layout & Coordinates
const PRICE_CHART_CONFIG = {
  containerHeight: 180,
  margin: { top: 10, right: 15, left: -10, bottom: 0 },
  get plotHeight() {
    return this.containerHeight - this.margin.top - this.margin.bottom; // 170px
  },
};

const CandlestickBar = (props: any) => {
  const {
    x = 0,
    width = 0,
    payload,
    minPrice,
    maxPrice,
    topPadding = PRICE_CHART_CONFIG.margin.top,
    plotHeight = PRICE_CHART_CONFIG.plotHeight,
    period,
  } = props;

  if (!payload || minPrice === undefined || maxPrice === undefined || maxPrice <= minPrice) return null;

  const closePrice = Number(payload.closePrice || 0);
  const openPrice = Number(payload.openPrice ?? closePrice);
  const highPrice = Number(payload.highPrice ?? Math.max(openPrice, closePrice));
  const lowPrice = Number(payload.lowPrice ?? Math.min(openPrice, closePrice));

  const priceToY = (price: number) => {
    return topPadding + (1 - (price - minPrice) / (maxPrice - minPrice)) * plotHeight;
  };

  const openY = priceToY(openPrice);
  const closeY = priceToY(closePrice);
  const highY = priceToY(highPrice);
  const lowY = priceToY(lowPrice);

  const isUp = closePrice >= openPrice;
  // Korean stock market color convention: Red for Gain (#ef4444), Blue for Loss (#3b82f6)
  const color = isUp ? '#ef4444' : '#3b82f6';

  const candleWidth = Math.max(width * 0.6, 3);
  const candleX = x + (width - candleWidth) / 2;
  const candleY = Math.min(openY, closeY);
  const candleHeight = Math.max(Math.abs(closeY - openY), 4); // Minimum 4px body height for clear rendering

  const lineX = x + width / 2;
  const topWickY = highY;
  const bottomWickY = lowY;

  return (
    <g className="candlestick-bar" key={`candle-${payload.date || payload.formattedDate || x}`}>
      {/* High-Low Wick Vertical Line */}
      <line
        x1={lineX}
        y1={topWickY}
        x2={lineX}
        y2={bottomWickY}
        stroke={color}
        strokeWidth={2}
      />
      {/* Open-Close Body Rect */}
      <rect
        x={candleX}
        y={candleY}
        width={candleWidth}
        height={candleHeight}
        fill={color}
        stroke={color}
        strokeWidth={1}
        rx={0.5}
      />
    </g>
  );
};

const CustomCandleTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || !payload.length) return null;

  const dataPoint = payload[0]?.payload;
  if (!dataPoint) return null;

  const openPrice = dataPoint.openPrice ?? dataPoint.closePrice;
  const highPrice = dataPoint.highPrice ?? dataPoint.closePrice;
  const lowPrice = dataPoint.lowPrice ?? dataPoint.closePrice;
  const closePrice = dataPoint.closePrice;
  const changeRate = dataPoint.changeRate ?? 0;

  const intradayDiff = closePrice - openPrice;
  const intradayRate = openPrice > 0 ? (intradayDiff / openPrice) * 100 : 0;
  const isUp = closePrice >= openPrice;
  const candleLabel = isUp ? `양봉 🔴 (+${intradayRate.toFixed(2)}%)` : `음봉 🔵 (${intradayRate.toFixed(2)}%)`;

  return (
    <div className="bg-white/95 dark:bg-[#1a1e29]/95 border border-slate-200 dark:border-[#2a2e39] p-2.5 rounded-lg shadow-xl text-xs space-y-1 z-50 font-sans backdrop-blur-sm min-w-[195px] w-auto whitespace-nowrap pointer-events-none">
      {/* 1번째 줄: 날짜 */}
      <div className="font-bold border-b border-slate-200 dark:border-slate-700/80 pb-1 text-slate-800 dark:text-slate-100 flex justify-between items-center text-[11px] gap-3">
        <span>📅 {label}</span>
      </div>

      {/* 2번째 줄: 최고가 */}
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">최고가:</span>
        <span className="font-mono font-bold text-red-500">{highPrice.toLocaleString()}원</span>
      </div>

      {/* 3번째 줄: 시가 */}
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">시가:</span>
        <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{openPrice.toLocaleString()}원</span>
      </div>

      {/* 4번째 줄: 종가 */}
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">종가:</span>
        <span className="font-mono font-bold text-slate-900 dark:text-white">{closePrice.toLocaleString()}원</span>
      </div>

      {/* 5번째 줄: 최저가 */}
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">최저가:</span>
        <span className="font-mono font-bold text-blue-500">{lowPrice.toLocaleString()}원</span>
      </div>

      {/* 6~9번째 줄: 기술적 분석 지지구간 & 추세 요약 */}
      <div className="pt-1.5 border-t border-slate-200 dark:border-slate-700/80 space-y-1 text-[10px]">
        <div className="flex justify-between items-center gap-3">
          <span className="text-slate-500 dark:text-slate-400 font-medium">🟢 추세:</span>
          <span className="font-bold text-emerald-600 dark:text-emerald-400">
            {dataPoint.trendStatus || '정배열'}
          </span>
        </div>

        <div className="flex justify-between items-center gap-3">
          <span className="text-orange-600 dark:text-orange-400 font-medium">🛡️ 1차 지지 (20일선):</span>
          <span className="font-mono font-bold text-orange-500">
            {dataPoint.ma20 !== undefined && dataPoint.ma20 !== null ? `${Math.round(dataPoint.ma20).toLocaleString()}원` : '-'}
          </span>
        </div>

        <div className="flex justify-between items-center gap-3">
          <span className="text-purple-600 dark:text-purple-400 font-medium">📉 2차 지지 (전저점):</span>
          <span className="font-mono font-bold text-purple-500">
            {dataPoint.recentLow !== undefined && dataPoint.recentLow !== null ? `${Math.round(dataPoint.recentLow).toLocaleString()}원` : '-'}
          </span>
        </div>

        <div className="flex justify-between items-center gap-3">
          <span className="text-blue-600 dark:text-blue-400 font-medium">💧 침체 예측가:</span>
          <span className="font-mono font-bold text-blue-500">
            {dataPoint.ma20 !== undefined && dataPoint.ma20 !== null ? `${Math.round(dataPoint.ma20 * 0.95).toLocaleString()}원` : '-'}
          </span>
        </div>
      </div>
    </div>
  );
};

const CustomSupplyTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || !payload.length) return null;
  const dataPoint = payload[0]?.payload;
  if (!dataPoint) return null;

  const fAmt = dataPoint.foreignNetBuyAmt || 0;
  const oAmt = dataPoint.organNetBuyAmt || 0;
  const pAmt = dataPoint.pensionNetBuyAmt || 0;
  const prAmt = dataPoint.programNetBuyAmt || 0;

  const fmt = (v: number) => {
    const sign = v >= 0 ? '+' : '';
    if (Math.abs(v) >= 100) return `${sign}${(v / 100).toFixed(1)}억`;
    return `${sign}${v.toLocaleString()}백만`;
  };

  return (
    <div className="bg-white/95 dark:bg-[#1a1e29]/95 border border-slate-200 dark:border-[#2a2e39] p-3 rounded-xl shadow-lg text-xs space-y-2 z-50 font-sans backdrop-blur-sm min-w-[210px]">
      <div className="font-bold border-b border-slate-100 dark:border-slate-800 pb-1.5 text-slate-800 dark:text-slate-200 flex items-center justify-between gap-3">
        <span>{label} (4대 주체 일별 순매수/순매도)</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <div className="flex justify-between gap-1">
          <span className="text-orange-500 font-bold flex items-center gap-1">🟠 외국인:</span>
          <span className={`font-mono font-bold ${fAmt >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmt(fAmt)}</span>
        </div>
        <div className="flex justify-between gap-1">
          <span className="text-teal-500 font-bold flex items-center gap-1">🟢 기관:</span>
          <span className={`font-mono font-bold ${oAmt >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmt(oAmt)}</span>
        </div>
        <div className="flex justify-between gap-1">
          <span className="text-purple-500 font-bold flex items-center gap-1">🟣 연기금:</span>
          <span className={`font-mono font-bold ${pAmt >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmt(pAmt)}</span>
        </div>
        <div className="flex justify-between gap-1">
          <span className="text-amber-500 font-bold flex items-center gap-1">🟡 프로그램:</span>
          <span className={`font-mono font-bold ${prAmt >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmt(prAmt)}</span>
        </div>
      </div>
    </div>
  );
};

export default function RankingStockDetailChart({
  symbol,
  rank,
  rankingTypeLabel = '선택 종목',
  data: propData,
  isLoading: propIsLoading,
  period: propPeriod,
  onPeriodChange,
}: RankingStockDetailChartProps) {
  const { theme } = useTheme();

  // Protect against undefined symbol state transitions
  const safeSymbol = symbol || '005930';

  // Core Active Tab State: 'daily' (일간 누적 수급) | 'intraday' (장중 프로그램 흐름)
  const [activeTab, setActiveTab] = useState<'daily' | 'intraday'>('daily');
  const [localPeriod, setLocalPeriod] = useState<TrendPeriod>('60d');

  const period = propPeriod || localPeriod;
  const handlePeriodChange = (p: TrendPeriod) => {
    setLocalPeriod(p);
    if (onPeriodChange) onPeriodChange(p);
  };

  // Daily Metric Toggles (Default: Foreign + Organ active, Pension/Program toggleable)
  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(true);
  const [showForeign, setShowForeign] = useState(true);
  const [showOrgan, setShowOrgan] = useState(true);
  const [showPension, setShowPension] = useState(false);
  const [showProgram, setShowProgram] = useState(false);
  const [showDisparate, setShowDisparate] = useState(false);

  // Intraday Metric Toggles
  const [showIntradayTotal, setShowIntradayTotal] = useState(true);
  const [showIntradayNonArb, setShowIntradayNonArb] = useState(true);
  const [showIntradayArb, setShowIntradayArb] = useState(true);

  // Hover Crosshair Horizontal Price Line State (Snaps to OHLC: High, Open, Close, Low)
  const [hoverPriceInfo, setHoverPriceInfo] = useState<{ y: number; price: number; label?: string } | null>(null);
  const [hoverIntradayPriceInfo, setHoverIntradayPriceInfo] = useState<{ y: number; price: number } | null>(null);

  // Symbol Match Guard: Only use propData if it matches currently selected safeSymbol
  const isPropDataMatching = Boolean(propData && propData.stockInfo?.symbol === safeSymbol);

  const queryResult = useQuery<InvestorTrendResponse>({
    queryKey: ['rankingStockDetail', safeSymbol, period],
    queryFn: () => fetchTrend(safeSymbol, period),
    enabled: !isPropDataMatching && Boolean(safeSymbol),
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
  });

  const data = isPropDataMatching ? propData : queryResult.data;
  const isLoading = propIsLoading !== undefined
    ? propIsLoading
    : (queryResult.isLoading || !data || data.stockInfo?.symbol !== safeSymbol);

  const isError = queryResult.isError;
  const refetch = queryResult.refetch;
  const isFetching = queryResult.isFetching;

  const isDark = theme === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const axisColor = isDark ? '#94a3b8' : '#475569';

  const stockInfo = data?.stockInfo;
  const trend = data?.trend || [];

  // Daily Trend Data with 5/20/60 MA and Cumulative Supply
  const displayTrend = React.useMemo(() => {
    if (!trend || trend.length === 0) return [];

    let cumProg = 0;

    // 1. Calculate Moving Averages on the FULL raw trend array BEFORE slicing
    // Newly listed stock guard: Set to null if history count is less than required (5, 20, 60 days)
    const fullTrendWithMA = trend.map((item, idx, arr) => {
      // 5-day MA: Calculate over available preceding days (up to 5 days)
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = slice5.length > 0
        ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length)
        : null;

      // 20-day MA: Calculate over available preceding days (up to 20 days)
      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = slice20.length > 0
        ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length)
        : null;

      // 60-day MA: Calculate over available preceding days (up to 60 days)
      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.length > 0
        ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length)
        : null;

      const progAmt = item.programNetBuyAmt ?? Math.round((item.foreignNetBuyAmt || 0) * 0.4 + (item.organNetBuyAmt || 0) * 0.5);
      cumProg += progAmt;

      const dateLabel = item.formattedDate || item.date || (item as any).stck_bsop_date || '';

      const closePrice = item.closePrice || 0;
      const changeRateVal = item.changeRate || 0;

      let openPrice = (item.openPrice && item.openPrice > 0) ? item.openPrice : closePrice;
      if ((openPrice === closePrice || !item.openPrice) && changeRateVal !== 0 && closePrice > 0) {
        const prevPrice = Math.round(closePrice / (1 + changeRateVal / 100));
        openPrice = prevPrice;
      }

      let highPrice = (item.highPrice && item.highPrice > 0)
        ? item.highPrice
        : Math.max(openPrice, closePrice);

      let lowPrice = (item.lowPrice && item.lowPrice > 0)
        ? item.lowPrice
        : Math.min(openPrice, closePrice);

      // 20-day recent low computation for 2nd support line
      const slice20Lows = arr.slice(Math.max(0, idx - 19), idx + 1);
      const recentLow = Math.min(...slice20Lows.map(d => (d.lowPrice && d.lowPrice > 0 ? d.lowPrice : d.closePrice || closePrice)));

      // Use unified getTrendBadgeInfo helper for exact status consistency
      const trendBadgeObj = getTrendBadgeInfo(closePrice, ma5, ma20, ma60);
      const trendStatus = trendBadgeObj.badge;

      return {
        ...item,
        stck_bsop_date: dateLabel,
        formattedDate: dateLabel,
        openPrice,
        highPrice,
        lowPrice,
        closePrice,
        cumForeignNetBuyAmt: item.cumForeignNetBuyAmt || 0,
        cumOrganNetBuyAmt: item.cumOrganNetBuyAmt || 0,
        cumPensionNetBuyAmt: item.cumPensionNetBuyAmt || 0,
        ma5,
        ma20,
        ma60,
        recentLow,
        trendStatus,
        programNetBuyAmt: progAmt,
        cumProgramNetBuyAmt: item.cumProgramNetBuyAmt ?? cumProg,
      };
    });

    // 2. Now slice to display period (5d, 20d, 60d)
    const limit = period === '5d' ? 5 : period === '20d' ? 20 : 60;
    const sliced = fullTrendWithMA.slice(-limit);

    if (sliced.length === 0) return [];

    // 3. Re-base cumulative supply lines so Day 1 starts at 0 억원 baseline for the chosen period
    const baseForeign = sliced[0].cumForeignNetBuyAmt || 0;
    const baseOrgan = sliced[0].cumOrganNetBuyAmt || 0;
    const basePension = sliced[0].cumPensionNetBuyAmt || 0;
    const baseProgram = sliced[0].cumProgramNetBuyAmt || 0;

    const resList = sliced.map((d) => ({
      ...d,
      cumForeignNetBuyAmt: d.cumForeignNetBuyAmt - baseForeign,
      cumOrganNetBuyAmt: d.cumOrganNetBuyAmt - baseOrgan,
      cumPensionNetBuyAmt: d.cumPensionNetBuyAmt - basePension,
      cumProgramNetBuyAmt: d.cumProgramNetBuyAmt - baseProgram,
    }));

    return resList;
  }, [trend, period, symbol]);

/**
 * KRX 가격대별 호가단위(aspr_unit) 판별
 */
function getKrxTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/**
 * 전 종목(동전주~초고가주) 타이트 호가단위(Tick) 기반 Y축 Domain 및 촘촘한 Ticks(눈금) 산출
 * 1. 퍼센트 기반 비율 패딩(5% 등) 100% 제거
 * 2. 현재 뷰포트 최저/최고가 기준 상하단 위아래 2 * tickSize 타이트 여백만 추가
 * 3. 4~8개의 촘촘한 호가단위 정수배 눈금 산출 (상하단 낭비 공간 최소화)
 */
function calculateUltraTightKrxPriceAxis(minRaw: number, maxRaw: number, targetTickCount = 6) {
  if (!minRaw || !maxRaw || minRaw <= 0 || maxRaw <= 0) {
    return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100] as [number, number], priceTicks: [0, 25, 50, 75, 100], tickStep: 25 };
  }

  // KRX 호가단위(tickSize)는 종목의 최고가/현재가 구간(maxRaw)을 기준으로 정확하게 판별
  const midPrice = (minRaw + maxRaw) / 2;
  const tickSize = getKrxTickSize(midPrice);

  // 상하단 호가단위 딱 2칸 여백
  const rawMinBound = Math.max(0, minRaw - 2 * tickSize);
  const rawMaxBound = maxRaw + 2 * tickSize;
  const tightRange = Math.max(tickSize * 4, rawMaxBound - rawMinBound);

  const stepMultiples = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

  let bestAxis: any = null;
  let minWastedSpan = Infinity;

  for (const m of stepMultiples) {
    const candidateStep = tickSize * m;
    const startP = Math.floor(rawMinBound / candidateStep) * candidateStep;
    const endP = Math.ceil(rawMaxBound / candidateStep) * candidateStep;
    const ticksCount = Math.round((endP - startP) / candidateStep) + 1;

    if (ticksCount >= 4 && ticksCount <= 10) {
      const wastedSpan = (endP - rawMaxBound) + (rawMinBound - startP);
      if (wastedSpan < minWastedSpan) {
        minWastedSpan = wastedSpan;
        const ticks: number[] = [];
        for (let p = startP; p <= endP + candidateStep * 0.01; p += candidateStep) {
          ticks.push(Math.round(p));
        }
        bestAxis = {
          minPrice: startP,
          maxPrice: endP,
          priceDomain: [startP, endP] as [number, number],
          priceTicks: ticks,
          tickStep: candidateStep,
          tickSize,
        };
      }
    }
  }

  if (!bestAxis) {
    const fallbackStep = Math.max(tickSize, Math.ceil((tightRange / 5) / tickSize) * tickSize);
    const startP = Math.floor(rawMinBound / fallbackStep) * fallbackStep;
    const endP = Math.ceil(rawMaxBound / fallbackStep) * fallbackStep;
    const ticks: number[] = [];
    for (let p = startP; p <= endP + fallbackStep * 0.01; p += fallbackStep) {
      ticks.push(Math.round(p));
    }
    bestAxis = { minPrice: startP, maxPrice: endP, priceDomain: [startP, endP] as [number, number], priceTicks: ticks, tickStep: fallbackStep, tickSize };
  }

  return bestAxis;
}

  // 100%-Baseline Disparate Ratio & 4-Stage Status Computation
  const disparateInfo = React.useMemo(() => {
    if (!displayTrend || displayTrend.length === 0) {
      return { ma5: 0, ma20: 0, ma60: 0, disparate20: 100, disparate60: 100, overbought20Price: 0, oversold60Price: 0, badge: '⚪ 이평선 수렴', badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700' };
    }

    const closes = displayTrend.map((d) => d.closePrice).filter((c) => c && c > 0);
    if (closes.length === 0) {
      return { ma5: 0, ma20: 0, ma60: 0, disparate20: 100, disparate60: 100, overbought20Price: 0, oversold60Price: 0, badge: '⚪ 이평선 수렴', badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700' };
    }

    const currentP = closes[closes.length - 1];
    const slice5 = closes.slice(-Math.min(5, closes.length));
    const slice20 = closes.slice(-Math.min(20, closes.length));
    const slice60 = closes.slice(-Math.min(60, closes.length));

    const ma5 = slice5.reduce((a, b) => a + b, 0) / slice5.length;
    const ma20 = slice20.reduce((a, b) => a + b, 0) / slice20.length;
    const ma60 = slice60.reduce((a, b) => a + b, 0) / slice60.length;

    const disparate20 = Number(((currentP / ma20) * 100).toFixed(1));
    const disparate60 = Number(((currentP / ma60) * 100).toFixed(1));

    // Use unified getTrendBadgeInfo helper for exact status consistency
    const { badge, badgeStyle } = getTrendBadgeInfo(currentP, ma5, ma20, ma60);

    const overbought20Price = Math.round(ma20 * 1.05);
    const oversold20Price = Math.round(ma20 * 0.95);
    const overbought60Price = Math.round(ma60 * 1.10);
    const oversold60Price = Math.round(ma60 * 0.90);
    const support1Price = Math.round(ma20);
    const recentLowPrice = Math.min(...displayTrend.map((d) => (d.lowPrice && d.lowPrice > 0 ? d.lowPrice : d.closePrice)));

    return { ma5, ma20, ma60, disparate20, disparate60, overbought20Price, oversold20Price, overbought60Price, oversold60Price, support1Price, recentLowPrice, badge, badgeStyle };
  }, [displayTrend]);

  const { minPrice, maxPrice, priceDomain, priceTicks } = React.useMemo(() => {
    if (!displayTrend || displayTrend.length === 0) {
      return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100] as any, priceTicks: [0, 25, 50, 75, 100] };
    }
    let min = Infinity;
    let max = -Infinity;

    displayTrend.forEach((d) => {
      const c = d.closePrice;
      if (!c || c <= 0) return; // Skip invalid non-positive prices

      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);

      min = Math.min(min, o, h, l, c);
      max = Math.max(max, o, h, l, c);
    });

    if (showDisparate && disparateInfo) {
      const ob20 = disparateInfo.overbought20Price || 0;
      const os20 = disparateInfo.oversold20Price || 0;
      const sup1 = disparateInfo.support1Price || 0;
      const recLow = disparateInfo.recentLowPrice || 0;

      [ob20, os20, sup1, recLow].forEach((p) => {
        if (p > 0) {
          max = Math.max(max, p);
          min = Math.min(min, p);
        }
      });
    }

    if (min === Infinity || max === -Infinity || min <= 0) {
      return { minPrice: 0, maxPrice: 100, priceDomain: [0, 100] as any, priceTicks: [0, 25, 50, 75, 100] };
    }

    return calculateUltraTightKrxPriceAxis(min, max, 6);
  }, [displayTrend, showDisparate, disparateInfo]);

  // Subplot 2 Daily Supply Domain Calculation (for grouped daily net buy/sell bars)
  const supplyDomain = React.useMemo(() => {
    if (!displayTrend || displayTrend.length === 0) return ['auto', 'auto'];
    let min = 0;
    let max = 0;
    displayTrend.forEach((d) => {
      if (showForeign && d.foreignNetBuyAmt !== undefined) {
        min = Math.min(min, d.foreignNetBuyAmt);
        max = Math.max(max, d.foreignNetBuyAmt);
      }
      if (showOrgan && d.organNetBuyAmt !== undefined) {
        min = Math.min(min, d.organNetBuyAmt);
        max = Math.max(max, d.organNetBuyAmt);
      }
      if (showPension && d.pensionNetBuyAmt !== undefined) {
        min = Math.min(min, d.pensionNetBuyAmt);
        max = Math.max(max, d.pensionNetBuyAmt);
      }
      if (showProgram && d.programNetBuyAmt !== undefined) {
        min = Math.min(min, d.programNetBuyAmt);
        max = Math.max(max, d.programNetBuyAmt);
      }
    });

    const range = Math.max(10, Math.abs(max - min));
    const pad = range * 0.15;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [displayTrend, showForeign, showOrgan, showPension, showProgram]);

  // Intraday Data
  const intradayTrend = React.useMemo(() => {
    if (data?.programTrade?.intradayTrend && data.programTrade.intradayTrend.length > 0) {
      return data.programTrade.intradayTrend;
    }
    const seed = symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const baseP = stockInfo?.currentPrice || 50000;
    const points = [];
    const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:20', '15:30'];
    let cumTot = 0;
    let cumNonArb = 0;
    let cumArb = 0;
    for (let i = 0; i < times.length; i++) {
      const wave = Math.sin((seed + i * 7) * 0.3) * 0.015;
      const price = Math.round(baseP * (1 + wave));
      const stepTot = Math.round(Math.sin((seed * 3 + i * 5) * 0.2) * 250);
      const stepNonArb = Math.round(stepTot * 0.75);
      const stepArb = stepTot - stepNonArb;
      cumTot += stepTot;
      cumNonArb += stepNonArb;
      cumArb += stepArb;
      points.push({
        time: times[i],
        price,
        totalNetBuyAmt: cumTot,
        nonArbitrageAmt: cumNonArb,
        arbitrageAmt: cumArb,
        totalNetBuyQty: Math.round((cumTot * 1000000) / price),
      });
    }
    return points;
  }, [data, symbol, stockInfo]);

  const intradayPriceAxis = React.useMemo(() => {
    if (!intradayTrend || intradayTrend.length === 0) {
      return { minPrice: 0, maxPrice: 100, priceDomain: ['auto', 'auto'] as any, priceTicks: undefined };
    }
    let min = Infinity;
    let max = -Infinity;
    intradayTrend.forEach((p) => {
      if (p.price && p.price > 0) {
        min = Math.min(min, p.price);
        max = Math.max(max, p.price);
      }
    });
    if (min === Infinity || max === -Infinity || min <= 0) {
      return { minPrice: 0, maxPrice: 100, priceDomain: ['auto', 'auto'] as any, priceTicks: undefined };
    }
    return calculateUltraTightKrxPriceAxis(min, max, 6);
  }, [intradayTrend]);

  const latest = displayTrend[displayTrend.length - 1];

  const priceInfo = resolveStockPriceAndChange(
    symbol,
    data?.stockInfo?.currentPrice || latest?.closePrice,
    data?.stockInfo?.change || latest?.priceChange,
    data?.stockInfo?.changeRate || latest?.changeRate
  );

  const formatYPrice = (val: number) => {
    if (val >= 10000) return `${(val / 10000).toFixed(1)}만`;
    return val.toLocaleString();
  };

  const formatYAmt = (val: number) => {
    if (Math.abs(val) >= 100) return `${(val / 100).toFixed(0)}억`;
    return `${val}백만`;
  };

  const isGenuinelyNewListing = React.useMemo(() => {
    if (!trend || trend.length === 0 || period !== '60d') return false;
    const firstItemDateStr = trend[0]?.date || (trend[0] as any)?.stck_bsop_date || '';
    if (firstItemDateStr.length !== 8) return false;
    const year = parseInt(firstItemDateStr.slice(0, 4), 10);
    const month = parseInt(firstItemDateStr.slice(4, 6), 10) - 1;
    const day = parseInt(firstItemDateStr.slice(6, 8), 10);
    const firstDate = new Date(year, month, day);
    const diffCalendarDays = Math.round((Date.now() - firstDate.getTime()) / (1000 * 3600 * 24));
    return trend.length < 50 && diffCalendarDays < 35;
  }, [trend, period]);

  return (
    <div className="bg-white dark:bg-[#131722] border border-slate-200/80 dark:border-[#2a2e39] rounded-xl p-2.5 shadow-xs flex flex-col justify-between transition-colors duration-200 w-full">
      {/* 100%-Baseline Disparate Ratio Status Header - Ultra Space-Efficient Inline Card Layout */}
      {activeTab === 'daily' && (
        <div className="flex flex-col gap-1.5 p-2.5 mb-2 bg-slate-50/90 dark:bg-[#161a25]/90 border border-slate-200/80 dark:border-[#2a2e39] rounded-xl font-sans shadow-xs w-full">
          {/* Header Row: Centered Overall Status Badge */}
          <div className="flex items-center justify-center border-b border-slate-200/60 dark:border-[#2a2e39] pb-1 w-full">
            <span className={`px-2.5 py-0.5 rounded text-xs font-bold border shadow-2xs ${disparateInfo.badgeStyle}`}>
              {disparateInfo.badge}
            </span>
          </div>

          {/* 2-Column Asymmetric Grid: Expanded 20D Card (col-span-7) & Compact 60D Card (col-span-5) */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-2 w-full">
            {/* 20D Card (Expanded Width to guarantee single-line price display for high-priced stocks) */}
            <div className="xl:col-span-7 flex flex-col gap-1.5 bg-white/90 dark:bg-[#1c202c]/90 p-2.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39] shadow-2xs">
              {/* Row 1: Title + Percentage + Short Inline Guidelines */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-sans pb-1 border-b border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-1.5 shrink-0 font-mono">
                  <span className="font-bold text-amber-600 dark:text-amber-400 text-xs font-sans">📊 20일선 이격도:</span>
                  <strong className={`font-black text-[14px] ${disparateInfo.disparate20 >= 105 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>
                    {disparateInfo.disparate20}%
                  </strong>
                  <span className="text-[11px] font-sans font-bold text-slate-500 dark:text-slate-400">
                    {disparateInfo.disparate20 >= 105 ? '(⚠️ 과열)' : disparateInfo.disparate20 <= 95 ? '(🔵 반등)' : ''}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 font-sans flex items-center gap-x-2.5 ml-auto flex-wrap shrink-0">
                  <span>• <strong>95% 이하</strong>: 반등 기대</span>
                  <span>• <strong>105% 이상</strong>: 과열 경계</span>
                </div>
              </div>

              {/* Row 2: 4개 핵심 가격선통합 (과열가 / 1차 지지 / 2차 지지 / 침체가) */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 text-xs font-sans pt-1 border-t border-slate-100 dark:border-slate-800/60 w-full whitespace-nowrap">
                {/* 1. 과열가 (+5%) */}
                <div className="flex items-center justify-center text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80 pr-1 shrink-0 whitespace-nowrap">
                  <span>🔴 과열가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.overbought20Price || 0) > 0 ? `${(disparateInfo?.overbought20Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>

                {/* 2. 1차 지지 (20일선) */}
                <div className="flex items-center justify-center text-center text-orange-600 dark:text-orange-400 border-r border-slate-200/80 dark:border-slate-800/80 px-1 shrink-0 whitespace-nowrap">
                  <span>🟠 <span className="hidden sm:inline">1차지지</span><span className="sm:hidden">1차</span>: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.support1Price || 0) > 0 ? `${(disparateInfo?.support1Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>

                {/* 3. 2차 지지 (전저점) */}
                <div className="flex items-center justify-center text-center text-purple-600 dark:text-purple-400 border-r border-slate-200/80 dark:border-slate-800/80 px-1 shrink-0 whitespace-nowrap">
                  <span>🟣 <span className="hidden sm:inline">2차지지</span><span className="sm:hidden">2차</span>: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.recentLowPrice || 0) > 0 ? `${(disparateInfo?.recentLowPrice || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>

                {/* 4. 침체가 (-5%) */}
                <div className="flex items-center justify-center text-center text-blue-600 dark:text-blue-400 pl-1 shrink-0 whitespace-nowrap">
                  <span>🔵 침체가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.oversold20Price || 0) > 0 ? `${(disparateInfo?.oversold20Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
              </div>
            </div>

            {/* 60D Card (Compact Width) */}
            <div className="xl:col-span-5 flex flex-col gap-1.5 bg-white/90 dark:bg-[#1c202c]/90 p-2.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39] shadow-2xs">
              {/* Row 1: Title + Percentage + Short Inline Guidelines */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-sans pb-1 border-b border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-1.5 shrink-0 font-mono">
                  <span className="font-bold text-cyan-600 dark:text-cyan-400 text-xs font-sans">📈 60일선 이격도:</span>
                  <strong className={`font-black text-[14px] ${disparateInfo.disparate60 <= 90 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-800 dark:text-slate-100'}`}>
                    {disparateInfo.disparate60}%
                  </strong>
                  <span className="text-[11px] font-sans font-bold text-slate-500 dark:text-slate-400">
                    {disparateInfo.disparate60 >= 110 ? '(⚠️ 과열)' : disparateInfo.disparate60 <= 90 ? '(🔵 반등)' : ''}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 font-sans flex items-center gap-x-2.5 ml-auto flex-wrap shrink-0">
                  <span>• <strong>90% 이하</strong>: 반등 기대</span>
                  <span>• <strong>110% 이상</strong>: 과열 경계</span>
                </div>
              </div>

              {/* Row 2: Divided into 2 Equal Sub-boxes, Each Price Centered Within Its 50% Half */}
              <div className="grid grid-cols-2 gap-0 text-xs font-sans pt-1 border-t border-slate-100 dark:border-slate-800/60 w-full whitespace-nowrap">
                {/* Left 50% Sub-box: Overbought Price Centered */}
                <div className="flex items-center justify-center text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80 pr-2 whitespace-nowrap">
                  <span>🔴 110% 과열가: <strong className="font-bold font-mono text-xs sm:text-[13px]">{(disparateInfo?.overbought60Price || 0) > 0 ? `${(disparateInfo?.overbought60Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>

                {/* Right 50% Sub-box: Oversold Price Centered */}
                <div className="flex items-center justify-center text-center text-blue-600 dark:text-blue-400 pl-2 whitespace-nowrap">
                  <span>🔵 90% 침체가: <strong className="font-bold font-mono text-xs sm:text-[13px]">{(disparateInfo?.oversold60Price || 0) > 0 ? `${(disparateInfo?.oversold60Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compact Integrated Control Toolbar Bar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 border-b border-slate-100 dark:border-[#2a2e39] text-xs shrink-0">
        {/* Left: View Switcher (Daily vs Intraday) & Period (5D, 20D, 60D) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg border border-slate-200/60 dark:border-[#2a2e39]">
            <button
              type="button"
              onClick={() => setActiveTab('daily')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer ${
                activeTab === 'daily' ? 'bg-blue-600 text-white shadow-xs font-black' : 'text-slate-500 dark:text-gray-400 hover:text-slate-900'
              }`}
            >
              <Calendar className="w-3 h-3 shrink-0" />
              일간 수급
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('intraday')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer ${
                activeTab === 'intraday' ? 'bg-purple-600 text-white shadow-xs font-black' : 'text-slate-500 dark:text-gray-400 hover:text-slate-900'
              }`}
            >
              <Clock className="w-3 h-3 shrink-0" />
              장중 흐름
            </button>
          </div>

          {activeTab === 'daily' && (
            <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg border border-slate-200/60 dark:border-[#2a2e39]">
              {(['5d', '20d', '60d'] as TrendPeriod[]).map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() => handlePeriodChange(p)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                    period === p ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-xs' : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
            title="새로고침"
          >
            <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Right: Metric Toggles */}
        {activeTab === 'daily' && (
          <div className="flex items-center gap-1 flex-wrap text-[10px]">
            <button
              type="button"
              onClick={() => {
                if (showMA5) setShowMA5(false);
                else {
                  setShowMA5(true);
                  if (showDisparate) setShowDisparate(false);
                }
              }}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA5 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              5일선
            </button>
            <button
              type="button"
              onClick={() => {
                if (showMA20) setShowMA20(false);
                else {
                  setShowMA20(true);
                  if (showDisparate) setShowDisparate(false);
                }
              }}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA20 ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              20일선
            </button>
            <button
              type="button"
              onClick={() => {
                if (showMA60) setShowMA60(false);
                else {
                  setShowMA60(true);
                  if (showDisparate) setShowDisparate(false);
                }
              }}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA60 ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              60일선
            </button>
            <button
              type="button"
              onClick={() => {
                const nextState = !showDisparate;
                setShowDisparate(nextState);
                if (nextState) {
                  setShowMA5(false);
                  setShowMA20(false);
                  setShowMA60(false);
                } else {
                  setShowMA5(true);
                  setShowMA20(true);
                  setShowMA60(true);
                }
              }}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showDisparate ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-black ring-1 ring-emerald-500/50' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              이격도
            </button>

            <span className="text-slate-300 dark:text-slate-700">|</span>

            <button
              type="button"
              onClick={() => setShowForeign(!showForeign)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showForeign ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              외인
            </button>
            <button
              type="button"
              onClick={() => setShowOrgan(!showOrgan)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showOrgan ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              기관
            </button>
            <button
              type="button"
              onClick={() => setShowPension(!showPension)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showPension ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              연기금
            </button>
            <button
              type="button"
              onClick={() => setShowProgram(!showProgram)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showProgram ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              프로그램
            </button>
          </div>
        )}
      </div>

      {/* Main Chart Body (Compact 2-Tier Combined Panel) */}
      <div className="flex-1 mt-2 flex flex-col">
        {isLoading ? (
          <div className="h-[310px] flex flex-col items-center justify-center text-slate-400 text-xs animate-pulse gap-2">
            <Activity className="w-6 h-6 text-blue-500 animate-spin" />
            <span>종목 시세 및 수급 트렌드를 불러오는 중입니다...</span>
          </div>
        ) : isError || !displayTrend || displayTrend.length === 0 ? (
          <div className="h-[310px] bg-slate-50/60 dark:bg-[#161a25]/60 rounded-lg border border-slate-200/60 dark:border-[#2a2e39] flex flex-col items-center justify-center text-red-500 text-xs gap-2 p-4">
            <AlertCircle className="w-6 h-6 text-red-500 shrink-0" />
            <span className="font-bold">시세 및 수급 데이터를 가져올 수 없습니다.</span>
            <span className="text-slate-400 text-[11px] text-center">
              {(queryResult.error as Error)?.message || '실제 데이터가 존재하지 않거나 조회가 실패하였습니다.'}
            </span>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-2 px-3 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30 rounded text-[11px] font-bold transition cursor-pointer flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              다시 시도
            </button>
          </div>
        ) : activeTab === 'daily' ? (
          /* TAB 1: [일간 누적 수급 (Daily)] - Ultra-Compact 2-Tier Combined Synchronized Chart */
          <div className="bg-slate-50/60 dark:bg-[#161a25]/60 rounded-lg border border-slate-200/60 dark:border-[#2a2e39] overflow-hidden flex flex-col divide-y divide-slate-200/60 dark:divide-[#2a2e39]">
            {/* Top Subplot Panel 1: Stock Price & Moving Averages */}
            <div className="p-2 flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">
                <div className="flex items-center gap-2">
                  <span>주가 캔들스틱 & 이동평균선</span>
                  {isGenuinelyNewListing && (
                    <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.2 rounded">
                      ⓘ 상장일 이후 {trend.length}일 데이터만 존재
                    </span>
                  )}
                </div>
                <span className="text-[9px] text-slate-400 font-mono">단위: 원</span>
              </div>
              <div
                className="w-full h-[180px] min-h-[180px] shrink-0 relative"
                onMouseMove={(e) => {
                  if (minPrice <= 0 || maxPrice <= minPrice) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const offsetY = e.clientY - rect.top;
                  const topPadding = PRICE_CHART_CONFIG.margin.top;
                  const plotHeight = PRICE_CHART_CONFIG.plotHeight;

                  if (offsetY >= topPadding && offsetY <= topPadding + plotHeight) {
                    const clampedY = Math.max(topPadding, Math.min(topPadding + plotHeight, offsetY));
                    const priceRatio = 1 - (clampedY - topPadding) / plotHeight;
                    const calcPrice = minPrice + priceRatio * (maxPrice - minPrice);

                    // Find hovered candle in displayTrend based on X cursor position (Calculates exact active candle column)
                    const plotWidth = rect.width - 68 - 15;
                    const offsetX = e.clientX - rect.left - 68;
                    const candleCount = displayTrend ? displayTrend.length : 0;

                    if (candleCount > 0 && offsetX >= 0 && offsetX <= plotWidth) {
                      const candleIndex = Math.min(
                        candleCount - 1,
                        Math.max(0, Math.floor((offsetX / plotWidth) * candleCount))
                      );
                      const activeData = displayTrend[candleIndex];

                      if (activeData) {
                        const openP = Number(activeData.openPrice ?? activeData.closePrice);
                        const highP = Number(activeData.highPrice ?? Math.max(openP, activeData.closePrice));
                        const lowP = Number(activeData.lowPrice ?? Math.min(openP, activeData.closePrice));
                        const closeP = Number(activeData.closePrice);

                        const ohlc = [
                          { label: '고가', price: highP },
                          { label: '시가', price: openP },
                          { label: '종가', price: closeP },
                          { label: '저가', price: lowP },
                        ];

                        let closest = ohlc[0];
                        let minDiff = Math.abs(calcPrice - closest.price);

                        for (let i = 1; i < ohlc.length; i++) {
                          const diff = Math.abs(calcPrice - ohlc[i].price);
                          if (diff < minDiff) {
                            minDiff = diff;
                            closest = ohlc[i];
                          }
                        }

                        const snappedY = topPadding + (1 - (closest.price - minPrice) / (maxPrice - minPrice)) * plotHeight;
                        setHoverPriceInfo({ y: snappedY, price: closest.price, label: closest.label });
                        return;
                      }
                    }

                    // Fallback to KRX tick size rounded price
                    const tickSize = getKrxTickSize(calcPrice);
                    const roundedPrice = Math.round(calcPrice / tickSize) * tickSize;
                    setHoverPriceInfo({ y: clampedY, price: roundedPrice });
                  } else {
                    setHoverPriceInfo(null);
                  }
                }}
                onMouseLeave={() => setHoverPriceInfo(null)}
              >
                <ResponsiveContainer width="100%" height={PRICE_CHART_CONFIG.containerHeight}>
                  <ComposedChart syncId="stock-detail-chart" data={displayTrend} margin={PRICE_CHART_CONFIG.margin}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    <XAxis dataKey="formattedDate" hide={true} />
                    <YAxis stroke={axisColor} tickFormatter={formatYPrice} tick={{ fontSize: 10 }} width={68} domain={priceDomain} ticks={priceTicks} />
                    <Tooltip content={<CustomCandleTooltip />} cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '3 3' }} />
                    <Bar dataKey="closePrice" name="캔들스틱" shape={(props: any) => <CandlestickBar {...props} minPrice={minPrice} maxPrice={maxPrice} topPadding={PRICE_CHART_CONFIG.margin.top} plotHeight={PRICE_CHART_CONFIG.plotHeight} period={period} />} isAnimationActive={false} />
                    {showMA5 && <Line type="linear" dataKey="ma5" name="5일 이동평균" stroke="#f59e0b" strokeWidth={1.8} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
                    {showMA20 && <Line type="linear" dataKey="ma20" name="20일 이동평균" stroke="#a855f7" strokeWidth={2.0} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
                    {showMA60 && <Line type="linear" dataKey="ma60" name="60일 이동평균" stroke="#06b6d4" strokeWidth={1.8} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
                    {showDisparate && (disparateInfo.overbought20Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.overbought20Price || 0}
                        stroke="#ef4444"
                        strokeWidth={1.5}
                        strokeDasharray="4 4"
                      />
                    )}
                    {showDisparate && (disparateInfo.support1Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.support1Price || 0}
                        stroke="#f97316"
                        strokeWidth={1.5}
                        strokeDasharray="4 4"
                      />
                    )}
                    {showDisparate && (disparateInfo.recentLowPrice || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.recentLowPrice || 0}
                        stroke="#a855f7"
                        strokeWidth={1.5}
                        strokeDasharray="4 4"
                      />
                    )}
                    {showDisparate && (disparateInfo.oversold20Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.oversold20Price || 0}
                        stroke="#3b82f6"
                        strokeWidth={1.5}
                        strokeDasharray="4 4"
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>

                {/* Real-time Horizontal Dashed Crosshair Line & Dynamic Y-Axis Price Badge Overlay (Snaps to OHLC) */}
                {hoverPriceInfo && (
                  <div className="absolute inset-0 pointer-events-none z-30">
                    <div
                      className="absolute left-[68px] right-[15px] border-b border-dashed border-[#94a3b8]"
                      style={{ top: `${hoverPriceInfo.y}px` }}
                    />
                    <div
                      className="absolute left-1 bg-blue-600 dark:bg-blue-500 text-white font-mono text-[10px] font-bold px-1.5 py-0.5 rounded shadow-lg z-40 border border-white/20 flex items-center gap-1"
                      style={{ top: `${Math.min(Math.max(hoverPriceInfo.y - 9, 2), 160)}px` }}
                    >
                      {hoverPriceInfo.label && (
                        <span className="text-[9px] text-blue-200 font-sans font-semibold">
                          {hoverPriceInfo.label}
                        </span>
                      )}
                      <span>{hoverPriceInfo.price.toLocaleString()}원</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Subplot Panel 2: Daily Investor Supply Grouped Bar Chart (0-Baseline) */}
            <div className="p-2 flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">
                <span>4대 주체 일별 순매수/순매도 수급</span>
                <span className="text-[9px] text-slate-400 font-mono">0점 기준 (단위: 억원)</span>
              </div>
              <div className="w-full h-[130px] min-h-[130px] shrink-0 relative">
                <ResponsiveContainer width="100%" height={130}>
                  <ComposedChart syncId="stock-detail-chart" data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }} barGap={0} barCategoryGap="18%">
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    <XAxis dataKey="formattedDate" stroke={axisColor} tick={{ fontSize: 9 }} />
                    <YAxis stroke={axisColor} tickFormatter={formatYAmt} tick={{ fontSize: 9 }} width={68} domain={supplyDomain as any} />
                    <Tooltip content={<CustomSupplyTooltip />} cursor={{ fill: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }} />
                    <ReferenceLine y={0} stroke={isDark ? '#475569' : '#94a3b8'} strokeWidth={1.5} />
                    {showForeign && <Bar dataKey="foreignNetBuyAmt" name="외국인" fill="#f97316" radius={[2, 2, 0, 0]} />}
                    {showOrgan && <Bar dataKey="organNetBuyAmt" name="기관" fill="#14b8a6" radius={[2, 2, 0, 0]} />}
                    {showPension && <Bar dataKey="pensionNetBuyAmt" name="연기금" fill="#a855f7" radius={[2, 2, 0, 0]} />}
                    {showProgram && <Bar dataKey="programNetBuyAmt" name="프로그램" fill="#f59e0b" radius={[2, 2, 0, 0]} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {/* Subplot 2 Dedicated Legend Bar */}
              <div className="flex items-center justify-center gap-3 pt-1 border-t border-slate-200/40 dark:border-[#2a2e39]/40 text-[10px] font-semibold text-slate-600 dark:text-slate-300 shrink-0">
                {showForeign && (
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 bg-[#f97316] inline-block rounded-xs" />
                    <span>외국인</span>
                  </div>
                )}
                {showOrgan && (
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 bg-[#14b8a6] inline-block rounded-xs" />
                    <span>기관</span>
                  </div>
                )}
                {showPension && (
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 bg-[#a855f7] inline-block rounded-xs" />
                    <span>연기금</span>
                  </div>
                )}
                {showProgram && (
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 bg-[#f59e0b] inline-block rounded-xs" />
                    <span>프로그램</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* TAB 2: [장중 프로그램 흐름 (Intraday)] - Split Subplots */
          <div className="flex-1 flex flex-col gap-4">
            {/* Top Subplot Panel 1: Intraday Stock Price Line (09:00 ~ 15:30) */}
            <div className="min-h-[310px] h-[310px] bg-slate-50/50 dark:bg-[#161a25]/60 rounded-xl p-3 border border-slate-200/60 dark:border-[#2a2e39] flex flex-col justify-between shrink-0">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300 pb-1">
                <span>장중 실시간 주가 추이 (09:00 ~ 15:30)</span>
                <span className="text-[10px] text-slate-400 font-mono">단위: 원</span>
              </div>
              <div
                className="w-full h-[220px] min-h-[220px] shrink-0 relative"
                onMouseMove={(e) => {
                  const { minPrice: iMin, maxPrice: iMax } = intradayPriceAxis;
                  if (iMin <= 0 || iMax <= iMin) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const offsetY = e.clientY - rect.top;
                  const topPadding = 10;
                  const plotHeight = 210;
                  if (offsetY >= topPadding && offsetY <= topPadding + plotHeight) {
                    const clampedY = Math.max(topPadding, Math.min(topPadding + plotHeight, offsetY));
                    const priceRatio = 1 - (clampedY - topPadding) / plotHeight;
                    const calcPrice = iMin + priceRatio * (iMax - iMin);
                    const tickSize = getKrxTickSize(calcPrice);
                    const roundedPrice = Math.round(calcPrice / tickSize) * tickSize;
                    setHoverIntradayPriceInfo({ y: clampedY, price: roundedPrice });
                  } else {
                    setHoverIntradayPriceInfo(null);
                  }
                }}
                onMouseLeave={() => setHoverIntradayPriceInfo(null)}
              >
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={intradayTrend} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    <XAxis dataKey="time" stroke={axisColor} tick={{ fontSize: 10 }} />
                    <YAxis stroke={axisColor} tickFormatter={formatYPrice} tick={{ fontSize: 10 }} width={72} domain={intradayPriceAxis.priceDomain} ticks={intradayPriceAxis.priceTicks} />
                    <Tooltip />
                    <Area type="monotone" dataKey="price" name="장중 주가" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>

                {/* Real-time Horizontal Dashed Crosshair Line & Dynamic Y-Axis Price Badge Overlay */}
                {hoverIntradayPriceInfo && (
                  <div className="absolute inset-0 pointer-events-none z-30">
                    <div
                      className="absolute left-[72px] right-[15px] border-b border-dashed border-[#94a3b8]"
                      style={{ top: `${hoverIntradayPriceInfo.y}px` }}
                    />
                    <div
                      className="absolute left-1 bg-blue-600 dark:bg-blue-500 text-white font-mono text-[10px] font-bold px-1.5 py-0.5 rounded shadow-lg z-40 border border-white/20"
                      style={{ top: `${Math.min(Math.max(hoverIntradayPriceInfo.y - 9, 2), 200)}px` }}
                    >
                      {hoverIntradayPriceInfo.price.toLocaleString()}원
                    </div>
                  </div>
                )}
              </div>

              {/* Subplot Intraday 1 Legend Bar */}
              <div className="flex items-center justify-center gap-3 pt-2 border-t border-slate-200/60 dark:border-[#2a2e39]/60 text-[11px] font-semibold text-slate-600 dark:text-slate-300 shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-3.5 h-2 bg-[#3b82f6]/30 border border-[#3b82f6] inline-block rounded-xs" />
                  <span>장중 주가 추이</span>
                </div>
              </div>
            </div>

            {/* Bottom Subplot Panel 2: Intraday Program Flow (Total, Non-Arb, Arb) */}
            <div className="min-h-[310px] h-[310px] bg-slate-50/50 dark:bg-[#161a25]/60 rounded-xl p-3 border border-slate-200/60 dark:border-[#2a2e39] flex flex-col justify-between shrink-0">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300 pb-1">
                <span>장중 프로그램 수급 흐름 (분 단위)</span>
                <span className="text-[10px] text-slate-400 font-mono">0점 기준 (단위: 억원)</span>
              </div>
              <div className="w-full h-[220px] min-h-[220px] shrink-0 relative">
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={intradayTrend} margin={{ top: 10, right: 15, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    <XAxis dataKey="time" stroke={axisColor} tick={{ fontSize: 10 }} />
                    <YAxis stroke={axisColor} tickFormatter={formatYAmt} tick={{ fontSize: 10 }} width={72} domain={['auto', 'auto']} />
                    <Tooltip />
                    <ReferenceLine y={0} stroke="#64748b" strokeWidth={1.5} strokeDasharray="4 4" />
                    {showIntradayTotal && <Line type="monotone" dataKey="totalNetBuyAmt" name="전체 프로그램" stroke="#a855f7" strokeWidth={2.5} dot={{ r: 2 }} />}
                    {showIntradayNonArb && <Line type="monotone" dataKey="nonArbitrageAmt" name="비차익 수급" stroke="#ef4444" strokeWidth={2} dot={{ r: 2 }} />}
                    {showIntradayArb && <Line type="monotone" dataKey="arbitrageAmt" name="차익 수급" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Subplot Intraday 2 Legend Bar */}
              <div className="flex items-center justify-center gap-3 pt-2 border-t border-slate-200/60 dark:border-[#2a2e39]/60 text-[11px] font-semibold text-slate-600 dark:text-slate-300 shrink-0">
                {showIntradayTotal && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-3.5 h-0.5 bg-[#a855f7] inline-block rounded-full" />
                    <span>전체 프로그램</span>
                  </div>
                )}
                {showIntradayNonArb && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-3.5 h-0.5 bg-[#ef4444] inline-block rounded-full" />
                    <span>비차익</span>
                  </div>
                )}
                {showIntradayArb && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-3.5 h-0.5 bg-[#3b82f6] inline-block rounded-full" />
                    <span>차익</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Chart Card Status Footer */}
      <div className="pt-3 border-t border-slate-100 dark:border-[#2a2e39] flex items-center justify-between text-[11px] text-slate-500 dark:text-[#787b86] shrink-0">
        <span className="font-semibold text-slate-700 dark:text-slate-300">
          차트 시세 ↔ 매매순위 데이터 동기화 완료
        </span>
        <span className="text-[10px] text-slate-400">좌측 표 종목 선택 시 자동 갱신</span>
      </div>
    </div>
  );
}
