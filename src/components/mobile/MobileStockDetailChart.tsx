'use client';

// 데스크톱 RankingStockDetailChart.tsx(1987줄)의 모바일 2차 버전 - 1차(캔들+거래량+MA5/20/60)에
// 매물대 오버레이, 이격도(20/60/120일) 과열·침체 라인, 120일선, 신용정보 배지를 추가한다.
// VWAP은 3분봉(장중) 차트 전용 지표라 이 일간 차트 범위 밖이다 - 3분봉 탭을 별도로 만들 때 같이 추가한다.
// 캔들 렌더링/툴팁/추세배지는 CandlestickPrimitives.tsx 공통 모듈을 재사용(수칙 1-6, 1차와 동일).
// 매물대/이격도 계산은 IndexDetailChart.tsx에서 이미 검증된 패턴을, 분할 안전 처리(findSplitSafeStartIndex)
// 와 거래량 비율(computeRecentVolumeRatio)·KRX 호가단위 반올림(roundToKrxTick)은 RankingStockDetailChart.tsx가
// 쓰는 mockData.ts의 기존 함수를 그대로 재사용한다 - 새 계산 로직을 만들지 않는다.

import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { InvestorTrendDay, StockInfo } from '@/lib/types';
import { useTheme } from '@/providers/ThemeProvider';
import { PRICE_CHART_CONFIG, CandlestickBar, CustomCandleTooltip, CustomSupplyTooltip, CustomDailyVolumeTooltip, getTrendBadgeInfo } from '@/components/chart/CandlestickPrimitives';
import { findSplitSafeStartIndex, roundToKrxTick, computeRecentVolumeRatio } from '@/lib/mockData';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import MobileIntraday3mChart, { fetchIntraday3m } from './MobileIntraday3mChart';
import MobileLoadingSpinner from './MobileLoadingSpinner';

interface MobileStockDetailChartProps {
  trend: InvestorTrendDay[];
  stockInfo?: StockInfo;
  isLoading?: boolean;
}

// 종목 상세 차트(calculateUltraTightKrxPriceAxis)만큼 KRX 호가단위에 딱 맞진 않지만, 지수 상세 차트와
// 동일한 단순 nice-number 방식으로 충분히 커버한다.
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

export default function MobileStockDetailChart({ trend, stockInfo, isLoading }: MobileStockDetailChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#334155' : '#cbd5e1';
  const axisColor = isDark ? '#94a3b8' : '#475569';

  const [activeTab, setActiveTab] = useState<'daily' | '3m'>('daily');
  const [period, setPeriod] = useState<'5d' | '20d' | '60d'>('20d');
  const [show120dView, setShow120dView] = useState(false);
  const [showMA5, setShowMA5] = useState(true);
  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(false);
  const [showMA120, setShowMA120] = useState(false);
  const [showVolumeProfile, setShowVolumeProfile] = useState(true);
  const [showDisparate, setShowDisparate] = useState(false);
  // 🚨 [기능 추가] 데스크톱(RankingStockDetailChart.tsx)엔 있는 "4대 주체 일별 순매수/순매도 수급"
  // 막대그래프가 모바일엔 아예 없었다(사용자 지적) - 토글 상태부터 동일하게 이식(수칙 1-6).
  const [showForeign, setShowForeign] = useState(true);
  const [showOrgan, setShowOrgan] = useState(true);
  const [showProgram, setShowProgram] = useState(true);

  // 🚨 [재도입] 한 번 prefetch를 추가했다가, fetchKis3mCandlesFullDay가 14개 슬롯을 kisQueue 없이
  // 완전 병렬 호출하던 근본 결함 때문에 프로덕션 회귀가 나서 되돌렸었다. 이제 그 함수 자체를 kisQueue
  // 직렬화 + 8초 타임아웃으로 고쳤고(kisApi.ts:4531), investor-trend 페이지네이션의 동일 계열 타임아웃
  // 누락도 고쳤다(kisApi.ts:908) - 여러 종목을 빠르게 연달아 열어도 hang 없이 안정적임을 재현 테스트로
  // 확인한 뒤 다시 켠다. 무거운 3분봉 차트 컴포넌트를 이중 마운트하지 않고 데이터만 prefetchQuery로
  // 미리 당겨두며, MobileIntraday3mChart의 useQuery와 동일한 queryKey를 써서 나중에 탭을 누르면 이미
  // 채워진 캐시를 그대로 재사용한다.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!stockInfo?.symbol) return;
    queryClient.prefetchQuery({
      queryKey: ['m-intraday3m', stockInfo.symbol],
      queryFn: () => fetchIntraday3m(stockInfo.symbol),
      staleTime: 30 * 1000,
    });
  }, [stockInfo?.symbol, queryClient]);

  const rawTrend = trend || [];

  // 🚨 [기능 추가] 데스크톱(RankingStockDetailChart.tsx:478)에만 있던 "최초 거래량 돌파일 대비 오늘
  // 거래량 몇%" 안내가 모바일엔 없었다 - 완전히 동일한 공식 그대로 이식한다(수칙 1-6, 새 계산 로직
  // 만들지 않음). 표시 구간(displayTrend)과 무관하게 rawTrend(전체 배열) 기준으로 계산해야 5D/20D
  // 탭에서도 "최근 40영업일 스캔"이 온전히 동작한다.
  const recentVolumeBenchmark = React.useMemo(() => {
    if (!rawTrend || rawTrend.length < 2) return null;
    const todayIdx = rawTrend.length - 1;
    const today = rawTrend[todayIdx] as any;
    if (!today || !today.volume) return null;
    const isUpCandle = (d: any) => (d.closePrice ?? 0) >= (d.openPrice ?? 0);

    // 오늘 이전 최대 40영업일을 스캔한다. 각 날짜의 거래량을 "그 직전 5영업일 평균" 대비 배율로 보고,
    // 양봉이면서 배율이 3배 이상으로 처음(가장 이른 날짜) 튀는 날을 "돌파일"로 판정한다.
    const scanStart = Math.max(0, todayIdx - 40);
    const scanWindow = rawTrend.slice(scanStart, todayIdx) as any[];
    const BREAKOUT_MULTIPLIER = 3;
    let breakoutDay: any = null;
    for (let i = 5; i < scanWindow.length; i++) {
      const day = scanWindow[i];
      if (!day.volume || !isUpCandle(day)) continue;
      const baseline = scanWindow.slice(i - 5, i);
      const baselineAvg = baseline.reduce((sum, d) => sum + (d.volume || 0), 0) / baseline.length;
      if (baselineAvg > 0 && day.volume / baselineAvg >= BREAKOUT_MULTIPLIER) {
        breakoutDay = day;
        break; // 가장 이른(첫) 돌파일만 채택
      }
    }

    // 뚜렷한 돌파일이 없으면 최근 20영업일 중 양봉만 놓고 거래량 최댓값일로 대체한다.
    let peakDay = breakoutDay;
    if (!peakDay) {
      const fallbackWindow = (rawTrend.slice(Math.max(0, todayIdx - 20), todayIdx) as any[]).filter(isUpCandle);
      if (fallbackWindow.length > 0) {
        peakDay = fallbackWindow.reduce((a, b) => ((b.volume || 0) > (a.volume || 0) ? b : a));
      }
    }
    if (!peakDay || !peakDay.volume) return null;

    const ratio = Math.round((today.volume / peakDay.volume) * 100);
    return {
      peakDate: peakDay.formattedDate || peakDay.stck_bsop_date || '',
      peakVolume: peakDay.volume,
      ratio,
      isBreakoutDay: !!breakoutDay,
    };
  }, [rawTrend]);

  // MA5/20/60/120은 표시 구간과 무관하게 전체 배열 기준으로 계산해야 정확하다 - 잘린 배열로 평균 내면
  // 60일선과 120일선이 똑같아지는 가짜 계산이 된다(RankingStockDetailChart.tsx와 동일 이유).
  const fullTrendWithMA = React.useMemo(() => {
    return rawTrend.map((d, idx, arr) => {
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = slice5.reduce((acc, x) => acc + x.closePrice, 0) / slice5.length;
      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = slice20.reduce((acc, x) => acc + x.closePrice, 0) / slice20.length;
      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = slice60.reduce((acc, x) => acc + x.closePrice, 0) / slice60.length;
      const slice120 = arr.slice(Math.max(0, idx - 119), idx + 1);
      const ma120 = slice120.reduce((acc, x) => acc + x.closePrice, 0) / slice120.length;
      // 20일 평균 거래량 - 데스크톱 거래량 팝업(CustomDailyVolumeTooltip)이 "평균 대비 %"를 보여주는 데 쓴다.
      const volMa20 = Math.round(slice20.reduce((acc, x) => acc + (x.volume || 0), 0) / slice20.length);

      const volumeRatio = idx > 0 && arr[idx - 1].volume > 0 ? d.volume / arr[idx - 1].volume : null;
      const { badge } = getTrendBadgeInfo(d.closePrice, ma5, idx >= 19 ? ma20 : null, idx >= 59 ? ma60 : null, volumeRatio);

      return { ...d, ma5, ma20, ma60, ma120, volMa20, trendStatus: badge };
    });
  }, [rawTrend]);

  // 120D 버튼: 새 API 호출 없이 이미 받아온 풀 히스토리에서 표시 슬라이스만 120일로 넓힌다
  // (RankingStockDetailChart.tsx 1062~1079번 줄과 동일 UX).
  const displayTrend = React.useMemo(() => {
    const limit = show120dView ? 120 : period === '5d' ? 5 : period === '20d' ? 20 : 60;
    return fullTrendWithMA.slice(-limit);
  }, [fullTrendWithMA, period, show120dView]);

  // 이격도 & 4대(20/60/120일) 과열가/침체가 - RankingStockDetailChart.tsx 437~488번 줄과 동일 공식.
  // 액면분할/무상감자 등으로 가격 스케일이 급변한 구간은 findSplitSafeStartIndex로 제외한다(수칙 1-3).
  // 🚨 [기능 추가] "바닥 반등"/"단기과열" 같은 이격도 상태 배지(badge)가 모바일 종목 상세에는 아예 안
  // 떠 있었다 - 데스크톱은 getTrendBadgeInfo(RankingStockDetailChart.tsx:468)로 계산해서 헤더에
  // 보여주는데, 모바일은 disparate 숫자만 계산하고 badge/badgeStyle 필드 자체를 안 만들었다. 데스크톱과
  // 동일하게 ma5 + computeRecentVolumeRatio(당일 거래량/최근20일 평균 비율)까지 계산해 배지를 채운다.
  // 🚨 [버그 수정 - 수칙 1-6] 예전엔 displayTrend(현재 탭만큼 잘린 배열)에서 20/60/120일 평균을
  // 다시 계산했다 - 5D/20D 탭에서 displayTrend가 5개/20개짜리뿐이라 "20일선"/"60일선"이 조용히 더
  // 짧은 평균으로 대체됐다(데스크톱 RankingStockDetailChart.tsx와 동일 버그, 실측: 가온전선 000500
  // 5D 탭에서 20일선 이격도가 139.3%가 아니라 115.6%로 나옴). 이 컴포넌트는 부모(MobileStockDetailPanel
  // .tsx:16)가 애초에 항상 period=60d(180일치)로 조회해서 넘겨주므로, 잘리지 않은 원본 fullTrendWithMA
  // 기준으로 계산하면 탭과 무관하게 항상 정확하다 - 새 API 호출도 필요 없다.
  const disparateInfo = React.useMemo(() => {
    const emptyBadge = { badge: '⚪ 이평선 수렴', badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700' };
    const empty = { disparate20: 100, disparate60: 100, disparate120: 100, overbought20Price: 0, oversold20Price: 0, overbought60Price: 0, oversold60Price: 0, overbought120Price: 0, oversold120Price: 0, support1Price: 0, recentLowPrice: 0, ...emptyBadge };
    if (fullTrendWithMA.length === 0) return empty;

    const rawCloses = fullTrendWithMA.map((d) => d.closePrice).filter((c) => c && c > 0);
    if (rawCloses.length === 0) return empty;

    const closes = rawCloses.slice(findSplitSafeStartIndex(rawCloses));
    const splitSafeFullTrend = fullTrendWithMA.slice(fullTrendWithMA.length - closes.length);
    if (splitSafeFullTrend.length === 0) return empty;

    const currentP = closes[closes.length - 1];
    const slice5 = closes.slice(-Math.min(5, closes.length));
    const slice20 = closes.slice(-Math.min(20, closes.length));
    const slice60 = closes.slice(-Math.min(60, closes.length));
    const slice120 = closes.slice(-Math.min(120, closes.length));
    const ma5 = slice5.reduce((a, b) => a + b, 0) / slice5.length;
    const ma20 = slice20.reduce((a, b) => a + b, 0) / slice20.length;
    const ma60 = slice60.reduce((a, b) => a + b, 0) / slice60.length;
    const ma120 = slice120.reduce((a, b) => a + b, 0) / slice120.length;

    // 2차 지지(전저점)만은 의도적으로 "지금 보고 있는 탭 구간 안의 최저가"로 남겨둔다 - 이격도(20/60/
    // 120일 고정 기준)와 달리 "화면에 보이는 범위 안의 전저점"이라는 별개 개념이라 displayTrend를 쓴다.
    const recentLowPrice = displayTrend.length > 0
      ? Math.min(...displayTrend.map((d) => (d.lowPrice && d.lowPrice > 0 ? d.lowPrice : d.closePrice)))
      : 0;

    // 당일 거래량 / 최근 20일(당일 제외) 평균 거래량 비율 - getTrendBadgeInfo가 세력매집/설거지주의
    // 판별에 쓴다(RankingStockDetailChart.tsx:465와 동일). 이것도 원본 전체 배열 기준으로 계산한다.
    const volumeRatio = computeRecentVolumeRatio(splitSafeFullTrend.map((d) => d.volume));
    const { badge, badgeStyle } = getTrendBadgeInfo(currentP, ma5, ma20, ma60, volumeRatio);

    return {
      disparate20: Number(((currentP / ma20) * 100).toFixed(1)),
      disparate60: Number(((currentP / ma60) * 100).toFixed(1)),
      disparate120: Number(((currentP / ma120) * 100).toFixed(1)),
      overbought20Price: roundToKrxTick(ma20 * 1.05),
      oversold20Price: roundToKrxTick(ma20 * 0.95),
      overbought60Price: roundToKrxTick(ma60 * 1.10),
      oversold60Price: roundToKrxTick(ma60 * 0.90),
      overbought120Price: roundToKrxTick(ma120 * 1.10),
      oversold120Price: roundToKrxTick(ma120 * 0.90),
      badge,
      badgeStyle,
      support1Price: roundToKrxTick(ma20),
      recentLowPrice,
    };
  }, [fullTrendWithMA, displayTrend]);

  const { minPrice, maxPrice, priceDomain, priceTicks } = React.useMemo(() => {
    if (displayTrend.length === 0) return { minPrice: 0, maxPrice: 100, ...calculatePriceAxis(0, 100) };
    const highs = displayTrend.map((d) => d.highPrice || d.closePrice);
    const lows = displayTrend.map((d) => d.lowPrice || d.closePrice);
    const ma20s = showMA20 ? displayTrend.map((d) => d.ma20).filter((v) => v > 0) : [];
    const ma60s = showMA60 ? displayTrend.map((d) => d.ma60).filter((v) => v > 0) : [];
    const ma120s = showMA120 ? displayTrend.map((d) => d.ma120).filter((v) => v > 0) : [];
    const disparateVals = showDisparate
      ? [
          disparateInfo.overbought20Price, disparateInfo.oversold20Price,
          disparateInfo.overbought60Price, disparateInfo.oversold60Price,
          disparateInfo.overbought120Price, disparateInfo.oversold120Price,
          disparateInfo.recentLowPrice,
        ].filter((v) => v > 0)
      : [];
    const allVals = [...highs, ...lows, ...ma20s, ...ma60s, ...ma120s, ...disparateVals];
    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const axis = calculatePriceAxis(min, max);
    return { minPrice: axis.priceDomain[0], maxPrice: axis.priceDomain[1], ...axis };
  }, [displayTrend, showMA20, showMA60, showMA120, showDisparate, disparateInfo]);

  // 매물대(가격대별 누적 거래량) - 대표가(고가+저가+종가)/3에 그날 실거래량을 배정한다(가짜 틱데이터 없이
  // 실 OHLCV만 사용, IndexDetailChart.tsx와 동일 검증된 패턴).
  const volumeProfileBins = React.useMemo(() => {
    if (!showVolumeProfile || displayTrend.length === 0 || minPrice <= 0 || maxPrice <= minPrice) return [];
    const BIN_COUNT = 24;
    const binSize = (maxPrice - minPrice) / BIN_COUNT;
    const bins = Array.from({ length: BIN_COUNT }, (_, i) => ({ priceLow: minPrice + i * binSize, priceHigh: minPrice + (i + 1) * binSize, volume: 0 }));
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

  const formatYPrice = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const formatYVol = (v: number) => (v >= 100000000 ? `${Math.round(v / 100000000)}억` : v >= 10000 ? `${Math.round(v / 10000)}만` : v.toLocaleString());
  const formatYAmt = (v: number) => (Math.abs(v) >= 100 ? `${(v / 100).toFixed(0)}억` : `${v}백만`);

  // 4대 주체(외국인/기관/프로그램) 일별 순매수 - 데스크톱(RankingStockDetailChart.tsx:599)과 동일한
  // 0-baseline 그룹 막대 도메인 계산(수칙 1-6, 새 공식 만들지 않음).
  const supplyDomain = React.useMemo(() => {
    if (!displayTrend || displayTrend.length === 0) return ['auto', 'auto'] as [any, any];
    let min = 0;
    let max = 0;
    displayTrend.forEach((d: any) => {
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
    return [Math.floor(min - pad), Math.ceil(max + pad)] as [number, number];
  }, [displayTrend, showForeign, showOrgan, showProgram]);

  // 🚨 [사용자 요청] "120일도 너무 안 보여" - 60/120일 캔들을 좁은 모바일 화면 폭에 욱여넣으니 3분봉과
  // 똑같이 캔들이 짓눌려 안 보이는 문제가 있었다. 3분봉(MobileIntraday3mChart.tsx)에서 이미 검증된
  // "캔들 최소폭 보장 가로 스크롤 + Y축 가격은 스크롤 안 되는 고정 컬럼" 패턴을 여기도 그대로 적용한다
  // (수칙 1-6, MIN_CANDLE_PX=8도 3분봉과 동일하게 재사용). 5일/20일처럼 원래 폭에 다 들어가는 탭은
  // Math.max(..., 320)에 걸려 스크롤이 아예 안 생기므로 기존과 동일하게 보인다.
  const MIN_CANDLE_PX = 8;
  const chartWidth = Math.max(displayTrend.length * MIN_CANDLE_PX, 320);
  const dailyScrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (dailyScrollRef.current) {
      dailyScrollRef.current.scrollLeft = dailyScrollRef.current.scrollWidth;
    }
  }, [displayTrend.length]);

  return (
    <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-2.5">
      {/* 일간/3분봉 탭 전환 */}
      <div className="flex items-center bg-slate-100 dark:bg-[#1e222d] p-1 rounded-lg text-xs w-fit mb-2">
        <button
          onClick={() => setActiveTab('daily')}
          className={`px-2.5 py-1 rounded-md font-bold transition ${activeTab === 'daily' ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-[#787b86]'}`}
        >
          일간
        </button>
        <button
          onClick={() => setActiveTab('3m')}
          className={`px-2.5 py-1 rounded-md font-bold transition ${activeTab === '3m' ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-[#787b86]'}`}
        >
          3분봉
        </button>
      </div>

      {activeTab === '3m' ? (
        stockInfo?.symbol ? (
          <MobileIntraday3mChart symbol={stockInfo.symbol} />
        ) : (
          <MobileLoadingSpinner label="종목 정보를 불러오는 중입니다..." />
        )
      ) : isLoading ? (
        <MobileLoadingSpinner label="차트 데이터를 불러오는 중입니다..." />
      ) : displayTrend.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-xs">표시할 차트 데이터가 없습니다.</div>
      ) : (
      <>
      {/* 이격도 상태 배지(바닥 반등/단기과열/정배열/이평선 수렴 등) - 데스크톱
          RankingStockDetailChart.tsx:1325(일간)/942(3분봉)는 항상 보여주는데 모바일엔 없었다(사용자
          지적: "차트누르면 바닥 반등인지 그런거 안뜨잖아"). 신용정보 배지 바로 위 줄에 배치한다. */}
      <div className="flex justify-start mb-1.5">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${disparateInfo.badgeStyle}`}>
          {disparateInfo.badge}
        </span>
      </div>
      {/* 신용정보 배지 */}
      {stockInfo?.isCreditAvailable !== undefined && (
        <div className="flex justify-end mb-1.5">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
              stockInfo.isCreditAvailable
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                : 'bg-slate-50 dark:bg-[#1e222d] text-slate-400 border-slate-200 dark:border-[#2a2e39]'
            }`}
          >
            {stockInfo.isCreditAvailable ? <ShieldCheck className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
            {stockInfo.isCreditAvailable ? '신용가능' : '신용불가'}
          </span>
        </div>
      )}

      {/* 이격도 헤더 카드 (20일 / 60일·120일 통합) */}
      {showDisparate && (
        <div className="flex flex-col gap-1.5 mb-2">
          <div className="flex flex-col gap-1 bg-slate-50/90 dark:bg-[#161a25]/90 p-2 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]">
            <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
              <span className="font-bold text-amber-600 dark:text-amber-400">20일:</span>
              <strong className={`font-black text-[13px] ${disparateInfo.disparate20 >= 105 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>{disparateInfo.disparate20}%</strong>
              <span className="text-[10px] text-slate-500">과열가 {disparateInfo.overbought20Price.toLocaleString()} · 침체가 {disparateInfo.oversold20Price.toLocaleString()}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 bg-slate-50/90 dark:bg-[#161a25]/90 p-2 rounded-lg border border-slate-200/80 dark:border-[#2a2e39]">
            <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
              <span className="font-bold text-cyan-600 dark:text-cyan-400">60일:</span>
              <strong className={`font-black text-[13px] ${disparateInfo.disparate60 <= 90 ? 'text-blue-600 dark:text-blue-400' : disparateInfo.disparate60 >= 110 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>{disparateInfo.disparate60}%</strong>
              <span className="text-[10px] text-slate-500">과열가 {disparateInfo.overbought60Price.toLocaleString()} · 침체가 {disparateInfo.oversold60Price.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
              <span className="font-bold text-fuchsia-600 dark:text-fuchsia-400">120일:</span>
              <strong className={`font-black text-[13px] ${disparateInfo.disparate120 <= 90 ? 'text-blue-600 dark:text-blue-400' : disparateInfo.disparate120 >= 110 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>{disparateInfo.disparate120}%</strong>
              <span className="text-[10px] text-slate-500">과열가 {disparateInfo.overbought120Price.toLocaleString()} · 침체가 {disparateInfo.oversold120Price.toLocaleString()}</span>
            </div>
          </div>
        </div>
      )}

      {/* 기간 & 지표 토글 */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <div className="flex items-center bg-slate-100 dark:bg-[#1e222d] p-1 rounded-lg text-xs">
          {(['5d', '20d', '60d'] as const).map((p) => (
            <button
              key={p}
              onClick={() => { setPeriod(p); setShow120dView(false); }}
              className={`px-2.5 py-1 rounded-md font-bold transition ${!show120dView && period === p ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-[#787b86]'}`}
            >
              {p === '5d' ? '5일' : p === '20d' ? '20일' : '60일'}
            </button>
          ))}
          <button
            onClick={() => { setPeriod('60d'); setShow120dView(true); }}
            className={`px-2.5 py-1 rounded-md font-bold transition ${show120dView ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-[#787b86]'}`}
          >
            120D
          </button>
        </div>
        {[
          { key: 'ma5', label: 'MA5', active: showMA5, setter: setShowMA5, color: 'text-amber-500 border-amber-500/40' },
          { key: 'ma20', label: 'MA20', active: showMA20, setter: setShowMA20, color: 'text-purple-500 border-purple-500/40' },
          { key: 'ma60', label: 'MA60', active: showMA60, setter: setShowMA60, color: 'text-cyan-500 border-cyan-500/40' },
          { key: 'ma120', label: 'MA120', active: showMA120, setter: setShowMA120, color: 'text-fuchsia-500 border-fuchsia-500/40' },
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
            // 🚨 [버그 수정] 이격도를 켜면 MA선(최대 4개: 5/20/60/120)이 기준선(최대 8개)과 겹쳐 화면이
            // 뭉개지는 문제가 있었다(사용자 지적으로 실측 확인) - 지수 상세 차트(MobileIndexDetailChart.tsx/
            // IndexDetailChart.tsx)는 이미 이격도 켤 때 MA를 자동으로 끄는 로직이 있었는데, 종목 상세
            // 차트만 이 로직이 빠져 있었다(MA5/20/60/120을 나중에 한꺼번에 추가하면서 누락). 동일하게
            // 맞춘다 - 이격도 켜면 MA 전부 끄고, 끄면 다시 켠다(수칙 1-6).
            const next = !showDisparate;
            setShowDisparate(next);
            if (next) {
              setShowMA5(false);
              setShowMA20(false);
              setShowMA60(false);
              setShowMA120(false);
            } else {
              setShowMA5(true);
              setShowMA20(true);
              setShowMA60(false);
              setShowMA120(false);
            }
          }}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showDisparate ? 'bg-white dark:bg-[#1e222d] text-emerald-600 dark:text-emerald-400 border-emerald-500/40 ring-1 ring-emerald-500/40' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          이격도
        </button>
        <span className="text-slate-300 dark:text-slate-700">|</span>
        {/* 🚨 [기능 추가] 데스크톱(RankingStockDetailChart.tsx:1247-1273)엔 있는 외인/기관/프로그램
            토글이 모바일엔 없었다 - 동일 색상/라벨로 이식(수칙 1-6). */}
        <button
          onClick={() => setShowForeign((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showForeign ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          외인
        </button>
        <button
          onClick={() => setShowOrgan((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showOrgan ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          기관
        </button>
        <button
          onClick={() => setShowProgram((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${showProgram ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-slate-50 dark:bg-[#131722] text-slate-400 border-slate-200 dark:border-[#2a2e39] opacity-50'}`}
        >
          프로그램
        </button>
      </div>

      {/* 캔들스틱 - Y축 가격은 스크롤 안 되는 고정 컬럼, 캔들/거래량은 가로 스크롤(3분봉과 동일 패턴) */}
      <div className="flex">
        <div className="shrink-0 relative" style={{ width: 52, height: PRICE_CHART_CONFIG.containerHeight }}>
          {priceTicks.map((t) => (
            <div
              key={`daily-fixed-ytick-${t}`}
              className="absolute text-[9px] font-mono"
              style={{ top: PRICE_CHART_CONFIG.margin.top + (1 - (t - minPrice) / (maxPrice - minPrice)) * PRICE_CHART_CONFIG.plotHeight - 6, left: 2, color: axisColor }}
            >
              {formatYPrice(t)}
            </div>
          ))}
        </div>
        <div ref={dailyScrollRef} className="overflow-x-auto flex-1 min-w-0">
        <div style={{ width: chartWidth }}>
        <div className="relative">
        {/* 🚨 [버그 수정] ResponsiveContainer가 부모 폭이 줄어드는(120D→5D처럼) 방향의 변화를 못 알아채고
            이전 폭(예: 960px)에 그대로 멈춰 있는 걸 실측으로 확인했다(늘어나는 방향은 정상 반영됨 - 편도
            버그). key를 chartWidth에 묶어 폭이 바뀔 때마다 강제로 새로 마운트시켜 매번 정확히 재측정하게
            한다. */}
        <ResponsiveContainer key={`price-${chartWidth}`} width="100%" height={PRICE_CHART_CONFIG.containerHeight}>
          {/* 🚨 [버그 수정] 데스크톱(RankingStockDetailChart.tsx:1353/1532/1603)은 캔들·4대주체·거래량
              3개 차트가 전부 같은 syncId를 공유해서 하나를 탭하면 세 팝업이 동시에 뜨고 동시에 사라진다.
              모바일은 이 syncId가 아예 없어서 차트마다 따로 놀았다(사용자 지적) - 3개 전부 동일한
              syncId를 추가해 데스크톱과 똑같이 통일한다. */}
          <ComposedChart syncId="mobile-stock-detail-chart" data={displayTrend} margin={PRICE_CHART_CONFIG.margin}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
            <XAxis dataKey="formattedDate" hide={true} />
            <YAxis stroke={axisColor} tick={false} axisLine={false} tickLine={false} width={52} domain={priceDomain} ticks={priceTicks} allowDataOverflow={true} />
            <Tooltip content={<CustomCandleTooltip priceLabel="원" />} cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '3 3' }} />
            <Bar dataKey="closePrice" name="캔들스틱" shape={(props: any) => <CandlestickBar {...props} minPrice={minPrice} maxPrice={maxPrice} topPadding={PRICE_CHART_CONFIG.margin.top} plotHeight={PRICE_CHART_CONFIG.plotHeight} />} isAnimationActive={false} />
            {showMA5 && <Line type="linear" dataKey="ma5" name="5일 이동평균" stroke="#f59e0b" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
            {showMA20 && <Line type="linear" dataKey="ma20" name="20일 이동평균" stroke="#a855f7" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
            {showMA60 && <Line type="linear" dataKey="ma60" name="60일 이동평균" stroke="#06b6d4" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
            {showMA120 && <Line type="linear" dataKey="ma120" name="120일 이동평균" stroke="#d946ef" strokeWidth={1.5} dot={false} activeDot={false} connectNulls={true} />}
            {showDisparate && disparateInfo.overbought20Price > 0 && <ReferenceLine y={disparateInfo.overbought20Price} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 4" />}
            {showDisparate && disparateInfo.support1Price > 0 && <ReferenceLine y={disparateInfo.support1Price} stroke="#f97316" strokeWidth={1.5} strokeDasharray="4 4" />}
            {showDisparate && disparateInfo.recentLowPrice > 0 && <ReferenceLine y={disparateInfo.recentLowPrice} stroke="#a855f7" strokeWidth={1.5} strokeDasharray="4 4" />}
            {showDisparate && disparateInfo.oversold20Price > 0 && <ReferenceLine y={disparateInfo.oversold20Price} stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 4" />}
            {showDisparate && disparateInfo.overbought60Price > 0 && <ReferenceLine y={disparateInfo.overbought60Price} stroke="#10b981" strokeWidth={1.5} strokeDasharray="4 2" />}
            {showDisparate && disparateInfo.oversold60Price > 0 && <ReferenceLine y={disparateInfo.oversold60Price} stroke="#10b981" strokeWidth={1.5} strokeDasharray="1 3" />}
            {showDisparate && disparateInfo.overbought120Price > 0 && <ReferenceLine y={disparateInfo.overbought120Price} stroke="#84cc16" strokeWidth={1.5} strokeDasharray="4 2" />}
            {showDisparate && disparateInfo.oversold120Price > 0 && <ReferenceLine y={disparateInfo.oversold120Price} stroke="#84cc16" strokeWidth={1.5} strokeDasharray="1 3" />}
          </ComposedChart>
        </ResponsiveContainer>

        {/* 매물대 반투명 오버레이 */}
        {showVolumeProfile && volumeProfileBins.length > 0 && (
          <div className="absolute left-0 right-[15px] top-2 bottom-0 pointer-events-none">
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

        {/* 4대 주체(외국인/기관/프로그램) 일별 순매수 - 데스크톱(RankingStockDetailChart.tsx:1561-1604)에는
            있는데 모바일엔 아예 없었다(사용자 지적) - 팝업(CustomSupplyTooltip)까지 완전히 동일하게 이식한다
            (수칙 1-6). 캔들/거래량과 같은 chartWidth 컨테이너 안에 있어야 가로 스크롤해도 x축이 안 어긋난다. */}
        <div className="mt-1">
          <div className="flex items-center justify-between text-[10px] font-bold text-slate-700 dark:text-slate-300 pb-0.5 px-0.5">
            <span>4대 주체 일별 순매수</span>
            <span className="text-[9px] text-slate-400 font-mono">0점 기준</span>
          </div>
          <ResponsiveContainer key={`supply-${chartWidth}`} width="100%" height={70}>
            <ComposedChart syncId="mobile-stock-detail-chart" data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }} barGap={0} barCategoryGap="18%">
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.7} />
              <XAxis dataKey="formattedDate" hide={true} />
              <YAxis stroke={axisColor} tickFormatter={formatYAmt} tick={{ fontSize: 8 }} width={52} domain={supplyDomain as any} />
              <Tooltip content={<CustomSupplyTooltip />} cursor={{ fill: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }} />
              <ReferenceLine y={0} stroke={isDark ? '#475569' : '#94a3b8'} strokeWidth={1.5} />
              {showForeign && <Bar dataKey="foreignNetBuyAmt" name="외국인" fill="#f97316" radius={[2, 2, 0, 0]} />}
              {showOrgan && <Bar dataKey="organNetBuyAmt" name="기관" fill="#14b8a6" radius={[2, 2, 0, 0]} />}
              {showProgram && <Bar dataKey="programNetBuyAmt" name="프로그램" fill="#f59e0b" radius={[2, 2, 0, 0]} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* 거래량 - 데스크톱(RankingStockDetailChart.tsx)과 동일한 팝업(CustomDailyVolumeTooltip, 양봉/음봉·
            20일 평균·평균 대비 %)을 그대로 재사용한다(수칙 1-6). 캔들과 같은 chartWidth 컨테이너 안에 있어야
            가로 스크롤해도 x축이 어긋나지 않는다 - Y축(거래량 눈금)은 3분봉과 동일하게 스크롤 대상에 포함. */}
        <div className="mt-1">
          <ResponsiveContainer key={`vol-${chartWidth}`} width="100%" height={70}>
            <ComposedChart syncId="mobile-stock-detail-chart" data={displayTrend} margin={{ top: 5, right: 15, left: -10, bottom: 0 }}>
              <XAxis dataKey="formattedDate" stroke={axisColor} tick={{ fontSize: 8 }} />
              <YAxis stroke={axisColor} tickFormatter={formatYVol} tick={{ fontSize: 8 }} width={52} />
              <Tooltip content={<CustomDailyVolumeTooltip />} cursor={{ fill: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }} />
              <Bar dataKey="volume" name="거래량" radius={[2, 2, 0, 0]}>
                {displayTrend.map((d, i) => (
                  <Cell key={`vol-${i}`} fill={d.closePrice >= (d.openPrice ?? d.closePrice) ? '#ef4444' : '#3b82f6'} fillOpacity={0.6} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        </div>
        </div>
      </div>

      {/* 4대 주체 범례 - 데스크톱(RankingStockDetailChart.tsx:1583-1603)과 동일. 가로 스크롤 영역 밖에
          둬서 5일/20일 탭(chartWidth 320px)에서도 안 잘리고 항상 보인다. */}
      {(showForeign || showOrgan || showProgram) && (
        <div className="flex items-center justify-center gap-3 pt-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
          {showForeign && (
            <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#f97316] inline-block rounded-xs" /><span>외국인</span></div>
          )}
          {showOrgan && (
            <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#14b8a6] inline-block rounded-xs" /><span>기관</span></div>
          )}
          {showProgram && (
            <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-[#f59e0b] inline-block rounded-xs" /><span>프로그램</span></div>
          )}
        </div>
      )}

      {/* "최초 거래량 돌파일 대비 오늘 거래량 몇%" 안내 - 데스크톱과 동일 문구/공식(recentVolumeBenchmark).
          가로 스크롤 영역(chartWidth) 밖, 화면 전체 폭에 표시해야 탭을 5일/20일로 바꿔 chartWidth가
          좁아져도(320px) 문구가 줄바꿈으로 안 잘리고 읽힌다. */}
      {recentVolumeBenchmark && (
        <div className={`flex items-center gap-1.5 text-[10px] font-bold px-0.5 pt-1.5 ${recentVolumeBenchmark.ratio >= 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
          <span>{recentVolumeBenchmark.ratio >= 100 ? '✅' : '⚠️'}</span>
          <span className="font-mono">
            {recentVolumeBenchmark.isBreakoutDay ? '최초 거래량 돌파일' : '최근 거래량 고점'} {recentVolumeBenchmark.peakDate}
            ({(recentVolumeBenchmark.peakVolume || 0).toLocaleString()}주) 대비 오늘 거래량 {recentVolumeBenchmark.ratio}%
          </span>
        </div>
      )}

      {/* 이격도 범례 바 */}
      {showDisparate && (
        <div className="flex items-center justify-center gap-2.5 pt-1.5 pb-0.5 text-[9px] font-semibold text-slate-600 dark:text-slate-300 flex-wrap">
          <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4 4" /></svg><span>20일 과열</span></div>
          <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 4" /></svg><span>20일 침체</span></div>
          <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 2" /></svg><span style={{ color: '#10b981' }}>60일 과열</span></div>
          <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#10b981" strokeWidth="1.5" strokeDasharray="1 3" /></svg><span style={{ color: '#10b981' }}>60일 침체</span></div>
          <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#84cc16" strokeWidth="1.5" strokeDasharray="4 2" /></svg><span style={{ color: '#84cc16' }}>120일 과열</span></div>
          <div className="flex items-center gap-1"><svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="#84cc16" strokeWidth="1.5" strokeDasharray="1 3" /></svg><span style={{ color: '#84cc16' }}>120일 침체</span></div>
        </div>
      )}

      </>
      )}
    </div>
  );
}
