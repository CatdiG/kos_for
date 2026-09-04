'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  Cell,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { InvestorTrendResponse, TrendPeriod } from '@/lib/types';
import { getStockName, resolveStockPriceAndChange, findSplitSafeStartIndex, roundToKrxTick, computeRecentVolumeRatio } from '@/lib/mockData';
import { TrendingUp, TrendingDown, Calendar, Activity, RefreshCw, AlertCircle, X } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';
import { PRICE_CHART_CONFIG, CandlestickBar, CustomCandleTooltip, getTrendBadgeInfo } from '@/components/chart/CandlestickPrimitives';

interface RankingStockDetailChartProps {
  symbol: string;
  rank?: number;
  rankingTypeLabel?: string;
  data?: InvestorTrendResponse;
  isLoading?: boolean;
  period?: TrendPeriod;
  onPeriodChange?: (period: TrendPeriod) => void;
  onClose?: () => void;
}

async function fetchTrend(symbol: string, period: TrendPeriod): Promise<InvestorTrendResponse> {
  const res = await fetch(`/api/stock/investor-trend?symbol=${symbol}&period=${period}&t=${Date.now()}`);
  if (!res.ok) {
    throw new Error('종목 시세 데이터를 불러오는데 실패했습니다.');
  }
  return res.json();
}

const CustomSupplyTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || !payload.length) return null;
  const dataPoint = payload[0]?.payload;
  if (!dataPoint) return null;

  const fmt = (v: number) => {
    const sign = v >= 0 ? '+' : '';
    if (Math.abs(v) >= 100) return `${sign}${(v / 100).toFixed(1)}억`;
    return `${sign}${v.toLocaleString()}백만`;
  };

  const fAmt = dataPoint.foreignNetBuyAmt ?? (payload.find((p: any) => p.dataKey === 'foreignNetBuyAmt')?.value || 0);
  const oAmt = dataPoint.organNetBuyAmt ?? (payload.find((p: any) => p.dataKey === 'organNetBuyAmt')?.value || 0);
  const prAmt = dataPoint.programNetBuyAmt ?? (payload.find((p: any) => p.dataKey === 'programNetBuyAmt')?.value || 0);

  return (
    <div className="bg-white/95 dark:bg-[#1e222d]/95 backdrop-blur-md p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-xl text-xs space-y-1 z-50">
      <div className="font-bold text-slate-700 dark:text-slate-200 pb-1 border-b border-slate-100 dark:border-slate-800">
        {label} 수급 동향
      </div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-1">
          <span className="text-orange-500 font-bold flex items-center gap-1">🟠 외국인:</span>
          <span className={`font-mono font-bold ${fAmt >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmt(fAmt)}</span>
        </div>
        <div className="flex justify-between gap-1">
          <span className="text-teal-500 font-bold flex items-center gap-1">🟢 기관:</span>
          <span className={`font-mono font-bold ${oAmt >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmt(oAmt)}</span>
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
  onClose,
}: RankingStockDetailChartProps) {
  const { theme } = useTheme();

  // Protect against undefined symbol state transitions
  const safeSymbol = symbol || '005930';

  // Core Active Tab State: 'daily' (일간 누적 수급) | '3m' (3분봉)
  const [activeTab, setActiveTab] = useState<'daily' | '3m'>('daily');
  const [localPeriod, setLocalPeriod] = useState<TrendPeriod>('60d');

  const period = propPeriod || localPeriod;
  const handlePeriodChange = (p: TrendPeriod) => {
    setLocalPeriod(p);
    if (onPeriodChange) onPeriodChange(p);
  };

  // Daily Metric Toggles (Default: Foreign + Organ + Program ALL ACTIVE)
  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(true);
  const [showMA120, setShowMA120] = useState(true);
  const [showForeign, setShowForeign] = useState(true);
  const [showOrgan, setShowOrgan] = useState(true);
  const [showProgram, setShowProgram] = useState(true);
  const [showDisparate, setShowDisparate] = useState(false);
  const [showVolumeProfile, setShowVolumeProfile] = useState(false);

  // 3m Candlestick Toggles
  const [show3mMA5, setShow3mMA5] = useState(true);
  const [show3mMA20, setShow3mMA20] = useState(true);
  const [show3mMA60, setShow3mMA60] = useState(true);
  const [show3mPivot, setShow3mPivot] = useState(true);
  const [show3mFibo, setShow3mFibo] = useState(true);
  const [show3mVolumeProfile, setShow3mVolumeProfile] = useState(false);
  // VWAP 선 + ±1·2σ 밴드를 하나로 묶어서 켜고 끈다(버튼도 하나로 통합됨).
  const [show3mVWAP, setShow3mVWAP] = useState(true);

  // Hover Crosshair Horizontal Price Line State (Snaps to OHLC: High, Open, Close, Low)
  const [hoverPriceInfo, setHoverPriceInfo] = useState<{ y: number; price: number; label?: string } | null>(null);
  const [hover3mPriceInfo, setHover3mPriceInfo] = useState<{ y: number; price: number } | null>(null);

  // Symbol Match Guard: Only use propData if it matches currently selected safeSymbol
  const isPropDataMatching = Boolean(propData && propData.stockInfo?.symbol === safeSymbol);

  const queryResult = useQuery<InvestorTrendResponse>({
    queryKey: ['rankingStockDetail', safeSymbol, period],
    queryFn: () => fetchTrend(safeSymbol, period),
    enabled: !isPropDataMatching && Boolean(safeSymbol),
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
  });

  // 한국 거래소 장중 여부 판별 (평일 09:00 ~ 15:30)
  const isMarketOpen = React.useMemo(() => {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const kst = new Date(utc + 9 * 60 * 60000);
    const day = kst.getDay();
    const timeNum = kst.getHours() * 100 + kst.getMinutes();
    return day >= 1 && day <= 5 && timeNum >= 900 && timeNum < 1530;
  }, []);

  // 3-Minute Candlestick + Pivot/Fibonacci On-Demand Query
  const intraday3mQuery = useQuery<any>({
    queryKey: ['intraday3mCandles', safeSymbol],
    queryFn: async () => {
      const res = await fetch(`/api/stock/intraday-chart?symbol=${safeSymbol}&timeUnit=3m&t=${Date.now()}`);
      if (!res.ok) throw new Error('3분봉 데이터를 불러오는데 실패했습니다.');
      return res.json();
    },
    enabled: activeTab === '3m' && Boolean(safeSymbol),
    staleTime: 30 * 1000,
    refetchInterval: isMarketOpen ? 30 * 1000 : false,
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

    // 액면분할/무상감자 등으로 옛 가격 스케일이 섞인 구간 감지 - 그 지점 이전 데이터는
    // 이동평균/전저점 계산에서 제외한다 (수칙 1-3: 가짜 보정 없이 오염 구간 자체를 제외)
    const rawClosesForSplitCheck = trend.map((d) => d.closePrice || 0);
    const splitBoundaryIdx = findSplitSafeStartIndex(rawClosesForSplitCheck);

    // 1. Calculate Moving Averages on the FULL raw trend array BEFORE slicing
    // Newly listed stock guard: Set to null if history count is less than required (5, 20, 60 days)
    const fullTrendWithMA = trend.map((item, idx, arr) => {
      // 분할 이후 날짜는 분할 경계 이전 데이터를 넘어가지 않도록 슬라이스 하한을 고정
      const sliceFloor = idx >= splitBoundaryIdx ? splitBoundaryIdx : 0;

      // 5-day MA: Calculate over available preceding days (up to 5 days)
      const slice5 = arr.slice(Math.max(sliceFloor, idx - 4), idx + 1);
      const ma5 = slice5.length > 0
        ? Math.round(slice5.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice5.length)
        : null;

      // 20-day MA: Calculate over available preceding days (up to 20 days)
      const slice20 = arr.slice(Math.max(sliceFloor, idx - 19), idx + 1);
      const ma20 = slice20.length > 0
        ? Math.round(slice20.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice20.length)
        : null;

      // 60-day MA: Calculate over available preceding days (up to 60 days)
      const slice60 = arr.slice(Math.max(sliceFloor, idx - 59), idx + 1);
      const ma60 = slice60.length > 0
        ? Math.round(slice60.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice60.length)
        : null;

      // 120-day MA: Calculate over available preceding days (up to 120 days) - arr는 최대 약 250 거래일치
      // 원본(raw) trend 전체 배열이므로(fetchKisInvestorTrend가 항상 365일 조회) period='60d' 화면에서도
      // 실제 120일 평균을 정석대로 계산할 수 있다 (수칙 1-3: 부족한 구간을 가짜로 채우지 않고 있는 만큼만 평균)
      const slice120 = arr.slice(Math.max(sliceFloor, idx - 119), idx + 1);
      const ma120 = slice120.length > 0
        ? Math.round(slice120.reduce((sum, d) => sum + (d.closePrice || 0), 0) / slice120.length)
        : null;

      // 당일 거래량 / 최근 20일(당일 제외) 평균 거래량 비율 - 세력매집/설거지주의 정교 판별용
      const sliceVol = arr.slice(Math.max(sliceFloor, idx - 20), idx + 1);
      const volumeRatio = computeRecentVolumeRatio(sliceVol.map((d) => d.volume));

      const progAmt = item.programNetBuyAmt || 0;
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
      const slice20Lows = arr.slice(Math.max(sliceFloor, idx - 19), idx + 1);
      const recentLow = Math.min(...slice20Lows.map(d => (d.lowPrice && d.lowPrice > 0 ? d.lowPrice : d.closePrice || closePrice)));

      // Use unified getTrendBadgeInfo helper for exact status consistency
      const trendBadgeObj = getTrendBadgeInfo(closePrice, ma5, ma20, ma60, volumeRatio);
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
        ma5,
        ma20,
        ma60,
        ma120,
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
    const baseProgram = sliced[0].cumProgramNetBuyAmt || 0;

    const resList = sliced.map((d) => ({
      ...d,
      cumForeignNetBuyAmt: d.cumForeignNetBuyAmt - baseForeign,
      cumOrganNetBuyAmt: d.cumOrganNetBuyAmt - baseOrgan,
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
      return { ma5: 0, ma20: 0, ma60: 0, ma120: 0, disparate20: 100, disparate60: 100, disparate120: 100, overbought20Price: 0, oversold60Price: 0, overbought120Price: 0, oversold120Price: 0, badge: '⚪ 이평선 수렴', badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700' };
    }

    const rawCloses = displayTrend.map((d) => d.closePrice).filter((c) => c && c > 0);
    if (rawCloses.length === 0) {
      return { ma5: 0, ma20: 0, ma60: 0, ma120: 0, disparate20: 100, disparate60: 100, disparate120: 100, overbought20Price: 0, oversold60Price: 0, overbought120Price: 0, oversold120Price: 0, badge: '⚪ 이평선 수렴', badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700' };
    }

    // 액면분할/무상감자 등 옛 가격 스케일 구간은 제외하고 계산 (수칙 1-3: 오염 구간 제외 방식)
    const closes = rawCloses.slice(findSplitSafeStartIndex(rawCloses));
    const splitSafeDisplayTrend = displayTrend.slice(displayTrend.length - closes.length);

    const currentP = closes[closes.length - 1];
    const slice5 = closes.slice(-Math.min(5, closes.length));
    const slice20 = closes.slice(-Math.min(20, closes.length));
    const slice60 = closes.slice(-Math.min(60, closes.length));

    const ma5 = slice5.reduce((a, b) => a + b, 0) / slice5.length;
    const ma20 = slice20.reduce((a, b) => a + b, 0) / slice20.length;
    const ma60 = slice60.reduce((a, b) => a + b, 0) / slice60.length;

    const disparate20 = Number(((currentP / ma20) * 100).toFixed(1));
    const disparate60 = Number(((currentP / ma60) * 100).toFixed(1));

    // 120일선: 여기 closes는 이미 period(5d/20d/60d)로 잘린 displayTrend 기준이라 최대 60개뿐이라서
    // slice(-120) 방식으로는 진짜 120일 평균을 만들 수 없다 (60일선과 똑같은 값이 되는 가짜 계산이 된다).
    // 대신 displayTrend 각 행에 이미 원본(raw) 전체 trend 배열(최대 약 250 거래일) 기준으로 정확히
    // 계산되어 있는 ma120 필드(fullTrendWithMA 참고)를 그대로 재사용한다 (수칙 1-3/1-6: 가짜 축소 계산 및
    // 중복 재구현 금지).
    const lastPoint = splitSafeDisplayTrend[splitSafeDisplayTrend.length - 1] as any;
    const ma120 = (lastPoint?.ma120 !== undefined && lastPoint?.ma120 !== null) ? lastPoint.ma120 : ma60;
    const disparate120 = Number(((currentP / ma120) * 100).toFixed(1));

    // 당일 거래량 / 최근 20일(당일 제외) 평균 거래량 비율 - 세력매집/설거지주의 정교 판별용
    const volumeRatio = computeRecentVolumeRatio(splitSafeDisplayTrend.map((d) => d.volume));

    // Use unified getTrendBadgeInfo helper for exact status consistency
    const { badge, badgeStyle } = getTrendBadgeInfo(currentP, ma5, ma20, ma60, volumeRatio);

    // 계산된 가격들을 실제 KRX 호가단위에 맞춰 반올림 (예: 4,456원처럼 실제로 존재하지 않는 호가 방지)
    const overbought20Price = roundToKrxTick(ma20 * 1.05);
    const oversold20Price = roundToKrxTick(ma20 * 0.95);
    const overbought60Price = roundToKrxTick(ma60 * 1.10);
    const oversold60Price = roundToKrxTick(ma60 * 0.90);
    // 120일선도 60일선과 동일한 90%/110% 과열·침체 기준을 그대로 적용 (사용자 요청: "다른 선들과 똑같이")
    const overbought120Price = roundToKrxTick(ma120 * 1.10);
    const oversold120Price = roundToKrxTick(ma120 * 0.90);
    const support1Price = roundToKrxTick(ma20);
    const recentLowPrice = Math.min(...splitSafeDisplayTrend.map((d) => (d.lowPrice && d.lowPrice > 0 ? d.lowPrice : d.closePrice)));

    return { ma5, ma20, ma60, ma120, disparate20, disparate60, disparate120, overbought20Price, oversold20Price, overbought60Price, oversold60Price, overbought120Price, oversold120Price, support1Price, recentLowPrice, badge, badgeStyle };
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

  // 매물대(가격대별 누적 거래량) - 하루의 대표가(고가+저가+종가)/3에 그날 실거래량을 배정해
  // 현재 화면 가격구간(minPrice~maxPrice)을 24개 구간으로 나눠 집계한다 (가짜 틱데이터 없이 실 OHLCV만 사용).
  const volumeProfileBins = React.useMemo(() => {
    if (!showVolumeProfile || !displayTrend || displayTrend.length === 0 || minPrice <= 0 || maxPrice <= minPrice) {
      return [];
    }
    const BIN_COUNT = 24;
    const binSize = (maxPrice - minPrice) / BIN_COUNT;
    const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({
      priceLow: minPrice + i * binSize,
      priceHigh: minPrice + (i + 1) * binSize,
      volume: 0,
    }));

    displayTrend.forEach((d) => {
      const c = d.closePrice || 0;
      if (c <= 0) return;
      const o = (d.openPrice && d.openPrice > 0) ? d.openPrice : c;
      const h = (d.highPrice && d.highPrice > 0) ? d.highPrice : Math.max(o, c);
      const l = (d.lowPrice && d.lowPrice > 0) ? d.lowPrice : Math.min(o, c);
      const vol = d.volume || 0;
      if (vol <= 0) return;
      const typicalPrice = (h + l + c) / 3;
      const idx = Math.max(0, Math.min(BIN_COUNT - 1, Math.floor((typicalPrice - minPrice) / binSize)));
      bins[idx].volume += vol;
    });

    const maxBinVolume = Math.max(1, ...bins.map((b) => b.volume));
    let pocIdx = 0;
    bins.forEach((b, i) => { if (b.volume > bins[pocIdx].volume) pocIdx = i; });

    return bins.map((b, i) => ({ ...b, ratio: b.volume / maxBinVolume, isPoc: i === pocIdx && b.volume > 0 }));
  }, [showVolumeProfile, displayTrend, minPrice, maxPrice]);

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
      if (showProgram && d.programNetBuyAmt !== undefined) {
        min = Math.min(min, d.programNetBuyAmt);
        max = Math.max(max, d.programNetBuyAmt);
      }
    });

    const range = Math.max(10, Math.abs(max - min));
    const pad = range * 0.15;
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [displayTrend, showForeign, showOrgan, showProgram]);

interface SwingLowPoint {
  price: number;
  time: string;
  formattedDate?: string;
  index: number;
}

/**
 * 3분봉 배열에서 앞뒤 각 2개 봉보다 저가가 더 낮은 국소 최저점(스윙 로우) 중
 * 아직 그 가격 아래로 종가가 마감된 적 없는(미이탈) 가장 최근 스윙 로우 1개 탐색
 */
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
      swingLows.push({
        price: currLow,
        time: candles[i].time,
        formattedDate: candles[i].formattedDate,
        index: i,
      });
    }
  }

  const activeSwingLows = swingLows.filter((sl) => {
    for (let k = sl.index + 1; k < candles.length; k++) {
      if (candles[k].closePrice < sl.price) {
        return false;
      }
    }
    return true;
  });

  if (activeSwingLows.length === 0) return null;
  return activeSwingLows[activeSwingLows.length - 1];
}

  // 3-Minute Candlestick + Pivot R1 Target Tight Domain Computation (하단: 최저가 - 2틱, 상단: R1 + 2틱)
  const candles3m = intraday3mQuery.data?.candles || [];
  const levels3m = intraday3mQuery.data?.levels;

  // 1. R1 저항 → 지지 전환 판정 (당일 장중 고가/종가가 R1 이상으로 돌파한 이력이 있는지)
  const isR1Flipped = React.useMemo(() => {
    const r1 = levels3m?.pivot?.r1;
    if (!r1 || !candles3m || candles3m.length === 0) return false;
    return candles3m.some((c: any) => (c.highPrice || c.closePrice) >= r1);
  }, [levels3m, candles3m]);

  // 2. 단기 지지선 (스윙 로우) 자동 탐지
  const activeSwingLow = React.useMemo(() => {
    return findActiveSwingLow(candles3m);
  }, [candles3m]);

  const intraday3mPriceAxis = React.useMemo(() => {
    if (!candles3m || candles3m.length === 0) {
      return { minPrice: 0, maxPrice: 100, priceDomain: ['auto', 'auto'] as any, priceTicks: undefined };
    }
    let candleMin = Infinity;
    let candleMax = -Infinity;
    candles3m.forEach((c: any) => {
      const o = c.openPrice || c.closePrice;
      const h = c.highPrice || Math.max(o, c.closePrice);
      const l = c.lowPrice || Math.min(o, c.closePrice);
      candleMin = Math.min(candleMin, o, h, l, c.closePrice);
      candleMax = Math.max(candleMax, o, h, l, c.closePrice);
    });

    if (candleMin === Infinity || candleMax === -Infinity || candleMin <= 0) {
      return { minPrice: 0, maxPrice: 100, priceDomain: ['auto', 'auto'] as any, priceTicks: undefined, showR2: false };
    }

    const r1 = levels3m?.pivot?.r1;
    const r2 = levels3m?.pivot?.r2;
    // 주가가 R1(1차 익절가)의 98% 이상 근접하거나 돌파 시 R2(신고가) 선과 Y축 자동 확장
    const showR2 = Boolean(r2 && r2 > 0 && r1 && r1 > 0 && candleMax >= r1 * 0.98);

    // 상단 기준가: 주가 급등 시 R2 기준, 평상시 R1 기준
    let targetMax = candleMax;
    if (showR2 && r2) {
      targetMax = Math.max(candleMax, r2);
    } else if (r1 && r1 > 0) {
      targetMax = Math.max(candleMax, r1);
    }

    // 하단 기준가: 당일 3분봉 캔들 최저가 및 스윙 로우 가격 포함
    let targetMin = candleMin;
    if (activeSwingLow && activeSwingLow.price > 0) {
      targetMin = Math.min(targetMin, activeSwingLow.price);
    }

    const tickSizeMin = getKrxTickSize(targetMin);
    const tickSizeMax = getKrxTickSize(targetMax);

    // 상하단 10틱 여백 적용 (하단: 최저가 - 10틱, 상단: 기준가 + 10틱)
    const exactMin = Math.max(0, targetMin - 10 * tickSizeMin);
    const exactMax = targetMax + 10 * tickSizeMax;
    const range = exactMax - exactMin;

    // 내부 눈금(Ticks) 생성을 위한 호가 정수배 step 탐색 (4~8개 눈금)
    const midTickSize = getKrxTickSize((exactMin + exactMax) / 2);
    const stepMultiples = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2500, 5000];

    let bestStep = midTickSize * 10;
    for (const m of stepMultiples) {
      const step = midTickSize * m;
      const count = range / step;
      if (count >= 3 && count <= 8) {
        bestStep = step;
        break;
      }
    }

    const firstTick = Math.ceil(exactMin / bestStep) * bestStep;
    const ticks: number[] = [];
    for (let p = firstTick; p < exactMax - bestStep * 0.1; p += bestStep) {
      ticks.push(Math.round(p));
    }

    return {
      minPrice: exactMin,
      maxPrice: exactMax,
      priceDomain: [exactMin, exactMax] as [number, number],
      priceTicks: ticks.length >= 2 ? ticks : undefined,
      showR2,
    };
  }, [candles3m, levels3m]);

  // 3분봉 매물대(가격대별 누적 거래량) - 일간 차트와 동일한 방식(대표가에 해당 봉 실거래량 배정)을
  // 3분봉 단위로 그대로 적용한다 (가짜 데이터 없이 실 3분봉 OHLCV만 사용).
  const volumeProfile3mBins = React.useMemo(() => {
    const { minPrice, maxPrice } = intraday3mPriceAxis;
    if (!show3mVolumeProfile || !candles3m || candles3m.length === 0 || minPrice <= 0 || maxPrice <= minPrice) {
      return [];
    }
    const BIN_COUNT = 24;
    const binSize = (maxPrice - minPrice) / BIN_COUNT;
    const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({
      priceLow: minPrice + i * binSize,
      priceHigh: minPrice + (i + 1) * binSize,
      volume: 0,
    }));

    candles3m.forEach((c: any) => {
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
  }, [show3mVolumeProfile, candles3m, intraday3mPriceAxis]);

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
      {/* Top Header Card - Tab-Aware: Daily (이격도 및 4대가격선) vs 3m (당일 피봇 & 피보나치 단타 가격선) */}
      {activeTab === 'daily' ? (
        /* 일간 수급 전용: 100%-Baseline 이격도 & 4대 핵심 가격선 헤더 카드 */
        <div className="flex flex-col gap-1.5 p-2.5 mb-2 bg-slate-50/90 dark:bg-[#161a25]/90 border border-slate-200/80 dark:border-[#2a2e39] rounded-xl font-sans shadow-xs w-full">
          {/* Header Row: Right-aligned Close Button (추세 뱃지는 하단 "주가 캔들스틱" 패널 타이틀 옆으로 이동 - 거래량 그래프 추가 공간 확보) */}
          <div className="relative flex items-center justify-end border-b border-slate-200/60 dark:border-[#2a2e39] pb-1 w-full min-h-[20px]">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="absolute right-0 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg bg-slate-200/80 hover:bg-slate-300 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] text-slate-700 dark:text-slate-200 font-bold text-xs transition flex items-center gap-1 cursor-pointer shadow-2xs"
                title="차트 닫기"
              >
                <span>차트 닫기</span>
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* 2-Column Asymmetric Grid: Expanded 20D Card (col-span-7) & Compact 60D Card (col-span-5) */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-2 w-full">
            {/* 20D Card */}
            <div className="xl:col-span-6 flex flex-col gap-1.5 bg-white/90 dark:bg-[#1c202c]/90 p-2.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39] shadow-2xs">
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
                  <span>• <strong>95% 이하</strong>: 반등</span>
                  <span>• <strong>105% 이상</strong>: 과열</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 text-xs font-sans pt-1 border-t border-slate-100 dark:border-slate-800/60 w-full whitespace-nowrap">
                <div className="flex items-center justify-center text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80 pr-1 shrink-0 whitespace-nowrap">
                  <span>🔴 과열가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.overbought20Price || 0) > 0 ? `${(disparateInfo?.overbought20Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
                <div className="flex items-center justify-center text-center text-orange-600 dark:text-orange-400 border-r border-slate-200/80 dark:border-slate-800/80 px-1 shrink-0 whitespace-nowrap">
                  <span>🟠 <span className="hidden sm:inline">1차지지</span><span className="sm:hidden">1차</span>: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.support1Price || 0) > 0 ? `${(disparateInfo?.support1Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
                <div className="flex items-center justify-center text-center text-purple-600 dark:text-purple-400 border-r border-slate-200/80 dark:border-slate-800/80 px-1 shrink-0 whitespace-nowrap">
                  <span>🟣 <span className="hidden sm:inline">2차지지</span><span className="sm:hidden">2차</span>: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.recentLowPrice || 0) > 0 ? `${(disparateInfo?.recentLowPrice || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
                <div className="flex items-center justify-center text-center text-blue-600 dark:text-blue-400 pl-1 shrink-0 whitespace-nowrap">
                  <span>🔵 침체가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.oversold20Price || 0) > 0 ? `${(disparateInfo?.oversold20Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
              </div>
            </div>

            {/* 60D·120D 통합 카드 - 20D 카드와 동일하게 헤더 1행 + 통계 1행 구조로 맞춰 높이/정렬을 통일했다 */}
            <div className="xl:col-span-6 flex flex-col gap-1.5 bg-white/90 dark:bg-[#1c202c]/90 p-2.5 rounded-lg border border-slate-200/80 dark:border-[#2a2e39] shadow-2xs">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-sans pb-1 border-b border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-1.5 shrink-0 font-mono flex-wrap">
                  <span className="font-bold text-slate-500 dark:text-slate-400 text-xs font-sans">📈 이격도:</span>
                  <span className="text-[10px] font-bold text-cyan-600 dark:text-cyan-400 font-sans">60일</span>
                  <strong className={`font-black text-[14px] ${disparateInfo.disparate60 <= 90 ? 'text-blue-600 dark:text-blue-400' : disparateInfo.disparate60 >= 110 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>
                    {disparateInfo.disparate60}%
                  </strong>
                  <span className="text-[10px] font-bold text-fuchsia-600 dark:text-fuchsia-400 font-sans">120일</span>
                  <strong className={`font-black text-[14px] ${disparateInfo.disparate120 <= 90 ? 'text-blue-600 dark:text-blue-400' : disparateInfo.disparate120 >= 110 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>
                    {disparateInfo.disparate120}%
                  </strong>
                </div>
                <span
                  className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-sans bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded shrink-0 ml-auto"
                  title="90% 이하: 반등 · 110% 이상: 과열 (60일선과 동일 기준)"
                >
                  60,120일선
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 text-xs font-sans pt-1 border-t border-slate-100 dark:border-slate-800/60 w-full whitespace-nowrap">
                <div className="flex items-center justify-center text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80 pr-1 shrink-0 whitespace-nowrap">
                  <span>🔴 <span className="hidden sm:inline">60일 </span>과열가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.overbought60Price || 0) > 0 ? `${(disparateInfo?.overbought60Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
                <div className="flex items-center justify-center text-center text-red-600 dark:text-red-400 border-r border-slate-200/80 dark:border-slate-800/80 px-1 shrink-0 whitespace-nowrap">
                  <span>🔴 <span className="hidden sm:inline">120일 </span>과열가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.overbought120Price || 0) > 0 ? `${(disparateInfo?.overbought120Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
                <div className="flex items-center justify-center text-center text-blue-600 dark:text-blue-400 border-r border-slate-200/80 dark:border-slate-800/80 px-1 shrink-0 whitespace-nowrap">
                  <span>🔵 <span className="hidden sm:inline">60일 </span>침체가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.oversold60Price || 0) > 0 ? `${(disparateInfo?.oversold60Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
                <div className="flex items-center justify-center text-center text-blue-600 dark:text-blue-400 pl-1 shrink-0 whitespace-nowrap">
                  <span>🔵 <span className="hidden sm:inline">120일 </span>침체가: <strong className="font-bold font-mono text-[11px] sm:text-xs">{(disparateInfo?.oversold120Price || 0) > 0 ? `${(disparateInfo?.oversold120Price || 0).toLocaleString()}원` : '-'}</strong></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* 3분봉 전용: 당일 3분봉 단타 피봇 & 피보나치 핵심 가격선 분석 카드 (이격도 삭제 및 피봇 특화) */
        levels3m && (
          <div className="flex flex-col gap-1.5 p-2.5 mb-2 bg-slate-50/90 dark:bg-[#161a25]/90 border border-slate-200/80 dark:border-[#2a2e39] rounded-xl font-sans shadow-xs w-full">
            {/* Header Row: Title & Close Button */}
            <div className="relative flex items-center justify-between border-b border-slate-200/60 dark:border-[#2a2e39] pb-1 w-full min-h-[26px] gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-bold border shadow-2xs ${disparateInfo.badgeStyle}`}>
                  {disparateInfo.badge}
                </span>
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400 truncate">
                  당일 3분봉 단타 피봇 & 피보나치 분석 (단위: 원)
                </span>
              </div>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-2.5 py-1 rounded-lg bg-slate-200/80 hover:bg-slate-300 dark:bg-[#1e222d] dark:hover:bg-[#2a2e39] text-slate-700 dark:text-slate-200 font-bold text-xs transition flex items-center gap-1 cursor-pointer shadow-2xs"
                  title="차트 닫기"
                >
                  <span>차트 닫기</span>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* 7개 핵심 피봇 & 피보나치 + 단기 지지선 지표 그리드 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-1.5 text-xs pt-1 text-center w-full">
              {/* 1. R2 (신고가) */}
              <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-600 dark:text-orange-400">
                <div className="text-[10px] font-bold">🟠 피봇 R2 (신고가)</div>
                <div className="font-mono font-black text-xs">{levels3m.pivot.r2.toLocaleString()}원</div>
              </div>

              {/* 2. R1 (1차 익절) */}
              <div className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400">
                <div className="text-[10px] font-bold">🔴 1차 익절 (R1)</div>
                <div className="font-mono font-black text-xs">{levels3m.pivot.r1.toLocaleString()}원</div>
              </div>

              {/* 3. 피봇 P (중심) */}
              <div className="p-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 dark:text-yellow-400">
                <div className="text-[10px] font-bold">🟡 피봇 P (중심)</div>
                <div className="font-mono font-black text-xs">{levels3m.pivot.p.toLocaleString()}원</div>
              </div>

              {/* 4. 단기 지지선 - 피봇 P 오른쪽 */}
              <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-600 dark:text-cyan-400">
                <div className="text-[10px] font-bold">💠 단기 지지선</div>
                <div className="font-mono font-black text-xs">
                  {activeSwingLow ? `${activeSwingLow.price.toLocaleString()}원` : '미형성'}
                </div>
              </div>

              {/* 5. 38.2% 최적 매수 */}
              <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                <div className="text-[10px] font-bold">🟢 최적 매수 (38.2%)</div>
                <div className="font-mono font-black text-xs">{levels3m.fibonacci.fibo382.toLocaleString()}원</div>
              </div>

              {/* 6. 50.0% 손절선 */}
              <div className="p-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-600 dark:text-purple-400">
                <div className="text-[10px] font-bold">⛔ 손절선 (50.0%)</div>
                <div className="font-mono font-black text-xs">{levels3m.fibonacci.fibo500.toLocaleString()}원</div>
              </div>

              {/* 7. S1 (지지) */}
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400">
                <div className="text-[10px] font-medium">🔵 피봇 S1 (지지)</div>
                <div className="font-mono font-bold text-xs">{levels3m.pivot.s1.toLocaleString()}원</div>
              </div>
            </div>
          </div>
        )
      )}

      {/* Compact Integrated Control Toolbar Bar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 border-b border-slate-100 dark:border-[#2a2e39] text-xs shrink-0">
        {/* Left: View Switcher (Daily vs Intraday) & Period (5D, 20D, 60D) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* 1. 일간 수급 버튼 + 5D/20D/60D 기간 선택 (부모 박스에 단일 종속) */}
          <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg border border-slate-200/60 dark:border-[#2a2e39]">
            <button
              type="button"
              onClick={() => setActiveTab('daily')}
              className={`px-1.5 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 cursor-pointer ${
                activeTab === 'daily' ? 'text-slate-800 dark:text-slate-200 font-extrabold' : 'text-slate-500 dark:text-gray-400 hover:text-slate-800'
              }`}
            >
              <Calendar className="w-3 h-3 shrink-0" />
              <span>일간 수급</span>
            </button>

            {(['5d', '20d', '60d'] as TrendPeriod[]).map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => {
                  handlePeriodChange(p);
                  if (activeTab !== 'daily') setActiveTab('daily');
                }}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  activeTab === 'daily' && period === p
                    ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-xs font-black'
                    : 'text-slate-500 dark:text-gray-400 hover:text-slate-900'
                }`}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>

          {/* 2. 3분봉 독립 버튼 (일간수급과 동일한 활성 테마 색상 적용) */}
          <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-[#1e222d] p-0.5 rounded-lg border border-slate-200/60 dark:border-[#2a2e39]">
            <button
              type="button"
              onClick={() => setActiveTab('3m')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center cursor-pointer ${
                activeTab === '3m'
                  ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-xs font-black'
                  : 'text-slate-500 dark:text-gray-400 hover:text-slate-900'
              }`}
            >
              <span>3분</span>
            </button>
          </div>

          {/* 3. 새로고침 버튼 (3분봉 우측 옆으로 배치) */}
          {activeTab === 'daily' ? (
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
              title="일간 수급 새로고침"
            >
              <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => intraday3mQuery.refetch()}
              disabled={intraday3mQuery.isFetching}
              className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
              title="3분봉 새로고침"
            >
              <RefreshCw className={`w-3 h-3 ${intraday3mQuery.isFetching ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>

        {/* Right: Metric Toggles */}
        {activeTab === '3m' && (
          <div className="flex items-center gap-1 flex-wrap text-[10px]">
            <button
              type="button"
              onClick={() => setShow3mMA5(!show3mMA5)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mMA5 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              5선
            </button>
            <button
              type="button"
              onClick={() => setShow3mMA20(!show3mMA20)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mMA20 ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              20선(황금선)
            </button>
            <button
              type="button"
              onClick={() => setShow3mMA60(!show3mMA60)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mMA60 ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              60선
            </button>
            <button
              type="button"
              onClick={() => setShow3mPivot(!show3mPivot)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mPivot ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              피봇선(P/R1/S1)
            </button>
            <button
              type="button"
              onClick={() => setShow3mFibo(!show3mFibo)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mFibo ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              피보나치(38.2%/50%)
            </button>
            <button
              type="button"
              onClick={() => setShow3mVolumeProfile(!show3mVolumeProfile)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mVolumeProfile ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
              title="가격대별 누적 거래량(매물대) 표시"
            >
              매물대
            </button>
            {/* 🚨 [버튼 통합] VWAP 선과 VWAP 밴드가 원래 별도 버튼(별도 상태)이었는데, 밴드는 VWAP 없이는
                의미가 없는 부속 지표라 두 버튼으로 나뉘어 있는 게 오히려 헷갈린다는 요청을 받아 하나로
                합쳤다 - show3mVWAP 하나로 VWAP 선과 밴드를 함께 켜고 끈다(show3mVWAPBand 상태 제거). */}
            <button
              type="button"
              onClick={() => setShow3mVWAP(!show3mVWAP)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                show3mVWAP ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
              title="당일 거래량가중평균가(장중 동적 지지/저항 기준선, indigo) + ±1·2 표준편차 밴드(초록). 날짜 바뀌면 매일 새로 리셋됨"
            >
              VWAP(±1·2σ)
            </button>
          </div>
        )}

        {/* Right: Metric Toggles */}
        {activeTab === 'daily' && (
          <div className="flex items-center gap-1 flex-wrap text-[10px]">
            <button
              type="button"
              onClick={() => {
                // 🚨 [요청 반영] 이격도가 켜진 상태에서 이 선을 따로 누르면 예전엔 이격도까지 같이
                // 꺼졌는데, "누른 선만 추가로 유지하고 이격도는 그대로 두고 싶다"는 요청을 받아 이격도를
                // 강제로 끄는 동작을 제거했다 - 이격도 버튼 자체의 "켜면 이평선 다 끄기" 동작은 그대로다.
                setShowMA5(!showMA5);
              }}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA5 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              5일선
            </button>
            <button
              type="button"
              onClick={() => setShowMA20(!showMA20)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA20 ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              20일선
            </button>
            <button
              type="button"
              onClick={() => setShowMA60(!showMA60)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA60 ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              60일선
            </button>
            <button
              type="button"
              onClick={() => setShowMA120(!showMA120)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showMA120 ? 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/30' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              120일선
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
                  setShowMA120(false);
                } else {
                  setShowMA5(true);
                  setShowMA20(true);
                  setShowMA60(true);
                  setShowMA120(true);
                }
              }}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showDisparate ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-black ring-1 ring-emerald-500/50' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
            >
              이격도
            </button>
            <button
              type="button"
              onClick={() => setShowVolumeProfile(!showVolumeProfile)}
              className={`px-1.5 py-0.5 rounded font-bold border transition cursor-pointer ${
                showVolumeProfile ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 font-black ring-1 ring-rose-500/50' : 'bg-slate-50 text-slate-400 border-slate-200 opacity-50'
              }`}
              title="가격대별 누적 거래량(매물대) 표시"
            >
              매물대
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
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold border shadow-2xs ${disparateInfo.badgeStyle}`}>
                    {disparateInfo.badge}
                  </span>
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
                    {showMA120 && <Line type="linear" dataKey="ma120" name="120일 이동평균" stroke="#d946ef" strokeWidth={1.8} strokeDasharray="5 5" dot={false} activeDot={false} connectNulls={true} />}
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
                    {/* 60일선·120일선 이격도 과열가/침체가 라인 (신규 추가) - 20일선(빨강/파랑)과 아예 겹치지 않는
                        새 색상(60일=에메랄드, 120일=라임)을 기간별로 하나씩 배정해 20일선과 헷갈리지 않게 하고,
                        같은 기간 내에서는 과열가(실선 계열)/침체가(성긴 점선)로 구분한다. 라인 이름표는 3분봉 탭과
                        동일하게 차트 안이 아니라 차트 바깥의 범례 바에서 표시한다 (아래 "일간 이격선 범례 바" 참고) */}
                    {showDisparate && (disparateInfo.overbought60Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.overbought60Price || 0}
                        stroke="#10b981"
                        strokeWidth={1.5}
                        strokeDasharray="4 2"
                      />
                    )}
                    {showDisparate && (disparateInfo.oversold60Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.oversold60Price || 0}
                        stroke="#10b981"
                        strokeWidth={1.5}
                        strokeDasharray="1 3"
                      />
                    )}
                    {showDisparate && (disparateInfo.overbought120Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.overbought120Price || 0}
                        stroke="#84cc16"
                        strokeWidth={1.5}
                        strokeDasharray="4 2"
                      />
                    )}
                    {showDisparate && (disparateInfo.oversold120Price || 0) > 0 && (
                      <ReferenceLine
                        y={disparateInfo.oversold120Price || 0}
                        stroke="#84cc16"
                        strokeWidth={1.5}
                        strokeDasharray="1 3"
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>

                {/* 매물대(가격대별 누적 거래량) 반투명 오버레이 - 새 서브플롯 없이 기존 캔들 차트 안에 겹쳐 그림 */}
                {showVolumeProfile && volumeProfileBins.length > 0 && (
                  <div className="absolute left-[68px] right-[15px] top-0 bottom-0 pointer-events-none">
                    <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
                      {volumeProfileBins.map((bin, i) => {
                        const topPadding = PRICE_CHART_CONFIG.margin.top;
                        const plotHeight = PRICE_CHART_CONFIG.plotHeight;
                        const yHigh = topPadding + (1 - (bin.priceHigh - minPrice) / (maxPrice - minPrice)) * plotHeight;
                        const yLow = topPadding + (1 - (bin.priceLow - minPrice) / (maxPrice - minPrice)) * plotHeight;
                        const barHeight = Math.max(1, yLow - yHigh - 1);
                        const maxBarWidthPct = 32; // 플롯 폭의 최대 32%까지만 침범
                        const widthPct = bin.ratio * maxBarWidthPct;
                        if (widthPct <= 0) return null;
                        return (
                          <rect
                            key={`vp-bin-${i}`}
                            x={`${100 - widthPct}%`}
                            y={yHigh}
                            width={`${widthPct}%`}
                            height={barHeight}
                            fill={bin.isPoc ? '#f43f5e' : '#64748b'}
                            opacity={bin.isPoc ? 0.55 : 0.25}
                            rx={1}
                          />
                        );
                      })}
                    </svg>
                  </div>
                )}

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

              {/* 일간 이격선 범례 바 (3분봉 탭과 동일한 방식으로 차트 바깥에 색상/기간 명시) */}
              {showDisparate && (
                <div className="flex items-center justify-center gap-3 pt-1.5 border-t border-slate-200/60 dark:border-[#2a2e39]/60 text-[10px] font-semibold text-slate-600 dark:text-slate-300 shrink-0 flex-wrap">
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4 4" /></svg>
                    <span>20일 과열가</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 4" /></svg>
                    <span>20일 침체가</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 2" /></svg>
                    <span className="font-bold" style={{ color: '#10b981' }}>60일 과열가</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#10b981" strokeWidth="1.5" strokeDasharray="1 3" /></svg>
                    <span className="font-bold" style={{ color: '#10b981' }}>60일 침체가</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#84cc16" strokeWidth="1.5" strokeDasharray="4 2" /></svg>
                    <span className="font-bold" style={{ color: '#84cc16' }}>120일 과열가</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#84cc16" strokeWidth="1.5" strokeDasharray="1 3" /></svg>
                    <span className="font-bold" style={{ color: '#84cc16' }}>120일 침체가</span>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Subplot Panel 2: Daily Investor Supply Grouped Bar Chart (0-Baseline) - 거래량 서브플롯 추가를 위해 높이를 130px→96px로 축소 */}
            <div className="p-2 flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">
                <span>4대 주체 일별 순매수/순매도 수급</span>
                <span className="text-[9px] text-slate-400 font-mono">0점 기준 (단위: 억원)</span>
              </div>
              <div className="w-full h-[96px] min-h-[96px] shrink-0 relative">
                <ResponsiveContainer width="100%" height={96}>
                  <ComposedChart syncId="stock-detail-chart" data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }} barGap={0} barCategoryGap="18%">
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    {/* 날짜축은 바로 아래 거래량 서브플롯에서 한 번만 표시 (중복 제거로 확보한 공간을 차트 높이에 재배분) */}
                    <XAxis dataKey="formattedDate" hide={true} />
                    <YAxis stroke={axisColor} tickFormatter={formatYAmt} tick={{ fontSize: 9 }} width={68} domain={supplyDomain as any} />
                    <Tooltip content={<CustomSupplyTooltip />} cursor={{ fill: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }} />
                    <ReferenceLine y={0} stroke={isDark ? '#475569' : '#94a3b8'} strokeWidth={1.5} />
                    {showForeign && <Bar dataKey="foreignNetBuyAmt" name="외국인" fill="#f97316" radius={[2, 2, 0, 0]} />}
                    {showOrgan && <Bar dataKey="organNetBuyAmt" name="기관" fill="#14b8a6" radius={[2, 2, 0, 0]} />}
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
                {showProgram && (
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 bg-[#f59e0b] inline-block rounded-xs" />
                    <span>프로그램</span>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Subplot Panel 3: Daily 거래량 바 차트 (신규 추가, Panel 2와 동일 syncId로 X축 동기화) */}
            <div className="p-2 flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">
                <div className="flex items-center gap-2">
                  <span>일별 거래량</span>
                  <span className="flex items-center gap-1 text-[9px] font-semibold text-red-500">
                    <span className="w-2 h-2 rounded-xs bg-red-500 inline-block" />양봉
                  </span>
                  <span className="flex items-center gap-1 text-[9px] font-semibold text-blue-500">
                    <span className="w-2 h-2 rounded-xs bg-blue-500 inline-block" />음봉
                  </span>
                </div>
                <span className="text-[9px] text-slate-400 font-mono">단위: 주</span>
              </div>
              <div className="w-full h-[64px] min-h-[64px] shrink-0 relative">
                <ResponsiveContainer width="100%" height={64}>
                  <ComposedChart syncId="stock-detail-chart" data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    <XAxis dataKey="formattedDate" stroke={axisColor} tick={{ fontSize: 9 }} />
                    <YAxis stroke={axisColor} tickFormatter={(v: number) => (v >= 100000000 ? `${Math.round(v / 100000000)}억` : v >= 10000 ? `${Math.round(v / 10000)}만` : v.toLocaleString())} tick={{ fontSize: 9 }} width={68} domain={[0, 'auto']} />
                    <Tooltip
                      formatter={(value: any, _name: any, item: any) => {
                        const isUp = item?.payload?.closePrice >= item?.payload?.openPrice;
                        return [`${Number(value).toLocaleString()}주`, isUp ? '거래량 (양봉)' : '거래량 (음봉)'];
                      }}
                    />
                    <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                      {displayTrend.map((entry: any, idx: number) => (
                        <Cell
                          key={`daily-vol-cell-${idx}`}
                          fill={entry.closePrice >= entry.openPrice ? '#ef4444' : '#3b82f6'}
                        />
                      ))}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        ) : (
          /* TAB 2: [3분봉 캔들스틱 + 피봇 & 피보나치 가이드라인] */
          <div className="flex-1 flex flex-col gap-3">
            {/* Top Subplot: 3분봉 캔들스틱 + 이동평균선 + 피봇/피보나치 오버레이 */}
            <div className="min-h-[310px] h-[310px] bg-slate-50/50 dark:bg-[#161a25]/60 rounded-xl p-3 border border-slate-200/60 dark:border-[#2a2e39] flex flex-col justify-between shrink-0">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300 pb-1">
                <div className="flex items-center gap-2">
                  <span>최근 3분봉 롤링 차트</span>
                  {intraday3mQuery.data?.statusNotice && (
                    <span className="text-[10px] font-normal px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                      {intraday3mQuery.data.statusNotice}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 font-mono">단위: 원</span>
              </div>
              <div
                className="w-full h-[220px] min-h-[220px] shrink-0 relative"
                onMouseMove={(e) => {
                  const { minPrice: iMin, maxPrice: iMax } = intraday3mPriceAxis;
                  if (iMin <= 0 || iMax <= iMin) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const offsetY = e.clientY - rect.top;
                  const topPadding = 10;
                  const plotHeight = 186;
                  if (offsetY >= topPadding && offsetY <= topPadding + plotHeight) {
                    const clampedY = Math.max(topPadding, Math.min(topPadding + plotHeight, offsetY));
                    const priceRatio = 1 - (clampedY - topPadding) / plotHeight;
                    const calcPrice = iMin + priceRatio * (iMax - iMin);
                    const tickSize = getKrxTickSize(calcPrice);
                    const roundedPrice = Math.round(calcPrice / tickSize) * tickSize;
                    setHover3mPriceInfo({ y: clampedY, price: roundedPrice });
                  } else {
                    setHover3mPriceInfo(null);
                  }
                }}
                onMouseLeave={() => setHover3mPriceInfo(null)}
              >
                {intraday3mQuery.isLoading ? (
                  <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
                    <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                    3분봉 캔들 및 피봇 지표를 불러오는 중...
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={candles3m} margin={{ top: 10, right: 75, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                      <XAxis dataKey="time" height={24} stroke={axisColor} tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                      <YAxis stroke={axisColor} tickFormatter={formatYPrice} tick={{ fontSize: 10 }} width={72} domain={intraday3mPriceAxis.priceDomain} allowDataOverflow={true} />
                      <Tooltip content={<CustomCandleTooltip />} />

                      {/* 피봇 수평선 (실선/점선) */}
                      {show3mPivot && levels3m && (
                        <>
                          {/* 주가가 R1에 근접/돌파 시 R2 신고가선 자동 표시 */}
                          {levels3m.pivot.r2 > 0 && intraday3mPriceAxis.showR2 && (
                            <ReferenceLine y={levels3m.pivot.r2} stroke="#f97316" strokeWidth={1.5} label={{ value: 'R2 신고가', fill: '#f97316', fontSize: 9, position: 'right' }} />
                          )}
                          {/* R1: 돌파 시 점선 '지지전환(R1-1)', 미돌파 시 실선 'R1 익절' */}
                          <ReferenceLine
                            y={levels3m.pivot.r1}
                            stroke="#ef4444"
                            strokeWidth={1.5}
                            strokeDasharray={isR1Flipped ? '4 2' : undefined}
                            label={{
                              value: isR1Flipped ? '지지전환(R1-1)' : 'R1 익절',
                              fill: '#ef4444',
                              fontSize: 9,
                              position: 'right',
                              fontWeight: isR1Flipped ? 'bold' : 'normal',
                            }}
                          />
                          <ReferenceLine y={levels3m.pivot.s1} stroke="#3b82f6" strokeWidth={1.5} label={{ value: 'S1 지지', fill: '#3b82f6', fontSize: 9, position: 'right' }} />
                        </>
                      )}

                      {/* 단기 지지선 (스윙 로우: 직전 국소 최저점) */}
                      {activeSwingLow && (
                        <ReferenceLine
                          y={activeSwingLow.price}
                          stroke="#06b6d4"
                          strokeWidth={1.5}
                          strokeDasharray="4 2"
                          label={{
                            value: '단기 지지선',
                            fill: '#06b6d4',
                            fontSize: 9,
                            position: 'right',
                            fontWeight: 'bold',
                          }}
                        />
                      )}

                      {/* 피보나치 수평선 (실선: 우측 라벨 정렬) */}
                      {show3mFibo && levels3m && (
                        <>
                          <ReferenceLine y={levels3m.fibonacci.fibo382} stroke="#10b981" strokeWidth={1.5} label={{ value: '38.2% 매수', fill: '#10b981', fontSize: 9, position: 'right' }} />
                          <ReferenceLine y={levels3m.fibonacci.fibo500} stroke="#a855f7" strokeWidth={1.5} label={{ value: '50% 손절', fill: '#a855f7', fontSize: 9, position: 'right' }} />
                        </>
                      )}

                      {/* 3분봉 캔들스틱 */}
                      <Bar dataKey="closePrice" shape={<CandlestickBar minPrice={intraday3mPriceAxis.minPrice} maxPrice={intraday3mPriceAxis.maxPrice} topPadding={10} plotHeight={186} />} isAnimationActive={false} />

                      {/* 분봉 이동평균선 3종 (점선: 5선 1굵기, 20선 2굵기, 60선 1굵기) */}
                      {show3mMA5 && <Line type="monotone" dataKey="ma5" stroke="#f97316" strokeDasharray="3 3" strokeWidth={1} dot={false} isAnimationActive={false} name="5선" />}
                      {show3mMA20 && <Line type="monotone" dataKey="ma20" stroke="#eab308" strokeDasharray="3 3" strokeWidth={2} dot={false} isAnimationActive={false} name="20선(황금선)" />}
                      {show3mMA60 && <Line type="monotone" dataKey="ma60" stroke="#a855f7" strokeDasharray="3 3" strokeWidth={1} dot={false} isAnimationActive={false} name="60선" />}
                      {/* VWAP(거래량가중평균가) - 이동평균선과 달리 점선이 아닌 실선으로 구분, 당일 장중
                          동적 지지/저항 기준선이라 피봇(전일 고정선)과 성격이 다름을 시각적으로 구분한다.
                          🚨 [색상 충돌 수정] 원래 #06b6d4(cyan)를 썼는데, 같은 3분봉 화면에 이미 "단기
                          지지선"(스윙 로우)이 동일한 cyan을 쓰고 있어서 두 선이 구분 안 되는 문제가 있었다
                          - indigo로 바꿔 겹치지 않게 함. */}
                      {show3mVWAP && <Line type="monotone" dataKey="vwap" stroke="#6366f1" strokeWidth={1.5} dot={false} isAnimationActive={false} name="VWAP" />}
                      {/* VWAP ±1·2 표준편차 밴드 - VWAP 실선보다 얇고 옅게, 1σ는 점선/2σ는 더 옅은 점선으로
                          구분해서 "밴드 안쪽(1σ)"과 "더 바깥쪽(2σ, 통계적 극단)"을 시각적으로 나눈다. */}
                      {show3mVWAP && (
                        <>
                          {/* 🚨 [색상 지정] 사용자 지정 색상 #2F9D27(진한 초록) 사용. 1σ는 원색 그대로,
                              2σ는 같은 색상의 옅은 톤(#8FCB89)으로 둬서 "안쪽(1σ)"과 "바깥쪽(2σ)"을
                              구분한다. 피보나치 38.2%선(#10b981, 청록에 가까운 초록)과 색상 계열이
                              가깝긴 하지만, 사용자가 이 정확한 색을 명시적으로 지정함. */}
                          <Line type="monotone" dataKey="vwapUpper1" stroke="#2F9D27" strokeWidth={2} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="VWAP +1σ" />
                          <Line type="monotone" dataKey="vwapLower1" stroke="#2F9D27" strokeWidth={2} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="VWAP -1σ" />
                          <Line type="monotone" dataKey="vwapUpper2" stroke="#8FCB89" strokeWidth={1.5} strokeDasharray="3 3" dot={false} isAnimationActive={false} name="VWAP +2σ" />
                          <Line type="monotone" dataKey="vwapLower2" stroke="#8FCB89" strokeWidth={1.5} strokeDasharray="3 3" dot={false} isAnimationActive={false} name="VWAP -2σ" />
                        </>
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}

                {/* 3분봉 매물대(가격대별 누적 거래량) 반투명 오버레이 - 일간 차트와 동일 패턴 */}
                {show3mVolumeProfile && volumeProfile3mBins.length > 0 && (
                  <div className="absolute left-[72px] right-[75px] top-0 bottom-0 pointer-events-none">
                    <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
                      {volumeProfile3mBins.map((bin, i) => {
                        const { minPrice: iMin, maxPrice: iMax } = intraday3mPriceAxis;
                        const topPadding = 10;
                        const plotHeight = 186;
                        const yHigh = topPadding + (1 - (bin.priceHigh - iMin) / (iMax - iMin)) * plotHeight;
                        const yLow = topPadding + (1 - (bin.priceLow - iMin) / (iMax - iMin)) * plotHeight;
                        const barHeight = Math.max(1, yLow - yHigh - 1);
                        const maxBarWidthPct = 32;
                        const widthPct = bin.ratio * maxBarWidthPct;
                        if (widthPct <= 0) return null;
                        return (
                          <rect
                            key={`vp3m-bin-${i}`}
                            x={`${100 - widthPct}%`}
                            y={yHigh}
                            width={`${widthPct}%`}
                            height={barHeight}
                            fill={bin.isPoc ? '#f43f5e' : '#64748b'}
                            opacity={bin.isPoc ? 0.55 : 0.25}
                            rx={1}
                          />
                        );
                      })}
                    </svg>
                  </div>
                )}

                {/* Hover Dashed Crosshair */}
                {hover3mPriceInfo && (
                  <div className="absolute inset-0 pointer-events-none z-30">
                    <div
                      className="absolute left-[72px] right-[75px] border-b border-dashed border-[#94a3b8]"
                      style={{ top: `${hover3mPriceInfo.y}px` }}
                    />
                    <div
                      className="absolute left-1 bg-amber-600 dark:bg-amber-500 text-white font-mono text-[10px] font-bold px-1.5 py-0.5 rounded shadow-lg z-40 border border-white/20"
                      style={{ top: `${Math.min(Math.max(hover3mPriceInfo.y - 9, 2), 200)}px` }}
                    >
                      {hover3mPriceInfo.price.toLocaleString()}원
                    </div>
                  </div>
                )}
              </div>

              {/* 3분봉 범례 바 (점선 및 굵기 1:1 완벽 시각화) */}
              <div className="flex items-center justify-center gap-3 pt-2 border-t border-slate-200/60 dark:border-[#2a2e39]/60 text-[10px] font-semibold text-slate-600 dark:text-slate-300 shrink-0 flex-wrap">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-red-500 inline-block rounded-xs" />
                  <span>양봉</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-blue-500 inline-block rounded-xs" />
                  <span>음봉</span>
                </div>
                {/* R1 상태 범례 */}
                {show3mPivot && levels3m && (
                  <div className="flex items-center gap-1">
                    {isR1Flipped ? (
                      <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
                    ) : (
                      <span className="w-2.5 h-1.5 bg-red-500 inline-block rounded-xs" />
                    )}
                    <span className={isR1Flipped ? 'text-red-600 dark:text-red-400 font-bold' : ''}>
                      {isR1Flipped ? '지지전환(R1-1)' : 'R1 익절'}
                    </span>
                  </div>
                )}
                {/* 단기 지지선 (스윙 로우) 범례 */}
                {activeSwingLow && (
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0">
                      <line x1="0" y1="3" x2="18" y2="3" stroke="#06b6d4" strokeWidth="1.5" strokeDasharray="4 2" />
                    </svg>
                    <span className="text-cyan-600 dark:text-cyan-400 font-bold">
                      단기 지지선 ({activeSwingLow.price.toLocaleString()}원)
                    </span>
                  </div>
                )}
                {show3mMA5 && (
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#f97316" strokeWidth="1" strokeDasharray="3 2" /></svg>
                    <span>5선</span>
                  </div>
                )}
                {show3mMA20 && (
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#eab308" strokeWidth="2" strokeDasharray="3 2" /></svg>
                    <span className="font-bold text-yellow-600 dark:text-yellow-400">20선(황금선)</span>
                  </div>
                )}
                {show3mMA60 && (
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#a855f7" strokeWidth="1" strokeDasharray="3 2" /></svg>
                    <span>60선</span>
                  </div>
                )}
                {show3mVWAP && (
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#6366f1" strokeWidth="1.5" /></svg>
                    <span className="font-bold text-indigo-600 dark:text-indigo-400">VWAP</span>
                  </div>
                )}
                {show3mVWAP && (
                  <div className="flex items-center gap-1">
                    <svg width="18" height="6" className="inline-block shrink-0"><line x1="0" y1="3" x2="18" y2="3" stroke="#2F9D27" strokeWidth="2" strokeDasharray="6 3" /></svg>
                    <span className="font-bold" style={{ color: '#2F9D27' }}>±1·2σ</span>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Subplot: 3분봉 거래량 바 차트 (상단 차트와 1:1 수직 정렬 동기화) */}
            <div className="min-h-[130px] h-[130px] bg-slate-50/50 dark:bg-[#161a25]/60 rounded-xl p-2 border border-slate-200/60 dark:border-[#2a2e39] flex flex-col justify-between shrink-0">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-300 pb-0.5">
                <span>3분봉 거래량</span>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-[9px] font-semibold text-red-500">
                    <span className="w-2 h-2 rounded-xs bg-red-500 inline-block" />매수(양봉)
                  </span>
                  <span className="flex items-center gap-1 text-[9px] font-semibold text-blue-500">
                    <span className="w-2 h-2 rounded-xs bg-blue-500 inline-block" />매도(음봉)
                  </span>
                  <span className="text-[9px] text-slate-400 font-mono">단위: 주</span>
                </div>
              </div>
              <div className="w-full h-[90px] min-h-[90px] shrink-0 relative">
                <ResponsiveContainer width="100%" height={90}>
                  <ComposedChart data={candles3m} margin={{ top: 5, right: 75, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
                    <XAxis dataKey="time" stroke={axisColor} tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                    <YAxis stroke={axisColor} tickFormatter={(v) => (v >= 10000 ? `${Math.round(v / 10000)}만` : v.toLocaleString())} tick={{ fontSize: 9 }} width={72} domain={[0, 'auto']} />
                    <Tooltip
                      formatter={(value: any, _name: any, item: any) => {
                        const isUp = item?.payload?.closePrice >= item?.payload?.openPrice;
                        return [`${Number(value).toLocaleString()}주`, isUp ? '거래량 (매수 우위/양봉)' : '거래량 (매도 우위/음봉)'];
                      }}
                    />
                    <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                      {candles3m.map((entry: any, idx: number) => (
                        <Cell
                          key={`vol-cell-${idx}`}
                          fill={entry.closePrice >= entry.openPrice ? '#ef4444' : '#3b82f6'}
                        />
                      ))}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
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
