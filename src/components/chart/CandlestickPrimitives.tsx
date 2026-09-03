'use client';

// 캔들스틱 차트 공통 프리미티브 (수칙 1-6: RankingStockDetailChart.tsx와 IndexDetailChart.tsx가 동일한
// 캔들 렌더링/툴팁/추세배지 로직을 각자 중복 구현하지 않도록 단일 공통 모듈로 분리했다).
// 종목 차트에서 그대로 옮겨온 코드이며, 종목/지수 어느 쪽이든 재사용 가능하도록 종목 전용 필드(수급 등)에는
// 의존하지 않는다.

import React from 'react';
import { computeUnifiedStatusBadge } from '@/lib/mockData';

export const PRICE_CHART_CONFIG = {
  containerHeight: 180,
  margin: { top: 10, right: 15, left: -10, bottom: 0 },
  get plotHeight() {
    return this.containerHeight - this.margin.top - this.margin.bottom; // 170px
  },
};

export function getTrendBadgeInfo(closePrice: number, ma5: number | null, ma20: number | null, ma60: number | null, volumeRatio?: number | null) {
  const res = computeUnifiedStatusBadge(closePrice, ma5, ma20, ma60, volumeRatio);
  return { badge: res.shortBadge, badgeStyle: res.badgeStyle };
}

export const CandlestickBar = (props: any) => {
  const {
    x = 0,
    width = 0,
    payload,
    minPrice,
    maxPrice,
    topPadding = PRICE_CHART_CONFIG.margin.top,
    plotHeight = PRICE_CHART_CONFIG.plotHeight,
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
      <line x1={lineX} y1={topWickY} x2={lineX} y2={bottomWickY} stroke={color} strokeWidth={2} />
      {/* Open-Close Body Rect */}
      <rect x={candleX} y={candleY} width={candleWidth} height={candleHeight} fill={color} stroke={color} strokeWidth={1} rx={0.5} />
    </g>
  );
};

export const CustomCandleTooltip = ({ active, payload, label, priceLabel = '원' }: any) => {
  if (!active || !payload || !payload.length) return null;

  const dataPoint = payload[0]?.payload;
  if (!dataPoint) return null;

  const openPrice = dataPoint.openPrice ?? dataPoint.closePrice;
  const highPrice = dataPoint.highPrice ?? dataPoint.closePrice;
  const lowPrice = dataPoint.lowPrice ?? dataPoint.closePrice;
  const closePrice = dataPoint.closePrice;

  const intradayDiff = closePrice - openPrice;
  const intradayRate = openPrice > 0 ? (intradayDiff / openPrice) * 100 : 0;
  const isUp = closePrice >= openPrice;
  const candleLabel = isUp ? `양봉 🔴 (+${intradayRate.toFixed(2)}%)` : `음봉 🔵 (${intradayRate.toFixed(2)}%)`;

  const fmt = (v: number) => (priceLabel === '원' ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

  return (
    <div className="bg-white/95 dark:bg-[#1a1e29]/95 border border-slate-200 dark:border-[#2a2e39] p-2.5 rounded-lg shadow-xl text-xs space-y-1 z-50 font-sans backdrop-blur-sm min-w-[195px] w-auto whitespace-nowrap pointer-events-none">
      <div className="font-bold border-b border-slate-200 dark:border-slate-700/80 pb-1 text-slate-800 dark:text-slate-100 flex justify-between items-center text-[11px] gap-3">
        <span>📅 {dataPoint.formattedDate ? `${dataPoint.formattedDate} ` : ''}{label}</span>
        <span className="text-[10px] text-slate-400 font-mono">{candleLabel}</span>
      </div>

      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">최고가:</span>
        <span className="font-mono font-bold text-red-500">{fmt(highPrice)}{priceLabel}</span>
      </div>

      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">시가:</span>
        <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{fmt(openPrice)}{priceLabel}</span>
      </div>

      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">종가:</span>
        <span className="font-mono font-bold text-slate-900 dark:text-white">{fmt(closePrice)}{priceLabel}</span>
      </div>

      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">최저가:</span>
        <span className="font-mono font-bold text-blue-500">{fmt(lowPrice)}{priceLabel}</span>
      </div>

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
            {dataPoint.ma20 !== undefined && dataPoint.ma20 !== null ? `${fmt(dataPoint.ma20)}${priceLabel}` : '-'}
          </span>
        </div>

        {dataPoint.recentLow !== undefined && dataPoint.recentLow !== null && (
          <div className="flex justify-between items-center gap-3">
            <span className="text-purple-600 dark:text-purple-400 font-medium">📉 2차 지지 (전저점):</span>
            <span className="font-mono font-bold text-purple-500">{fmt(dataPoint.recentLow)}{priceLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
};
