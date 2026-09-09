'use client';

// 캔들스틱 차트 공통 프리미티브 (수칙 1-6: RankingStockDetailChart.tsx와 IndexDetailChart.tsx가 동일한
// 캔들 렌더링/툴팁/추세배지 로직을 각자 중복 구현하지 않도록 단일 공통 모듈로 분리했다).
// 종목 차트에서 그대로 옮겨온 코드이며, 종목/지수 어느 쪽이든 재사용 가능하도록 종목 전용 필드(수급 등)에는
// 의존하지 않는다.

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

        {dataPoint.vwap !== undefined && dataPoint.vwap !== null && (
          <div className="flex justify-between items-center gap-3">
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">📊 VWAP (당일 평균단가):</span>
            <span className="font-mono font-bold text-indigo-500">{fmt(dataPoint.vwap)}{priceLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// 4대 주체(외국인/기관/프로그램) 일별 순매수 차트 공용 팝업 - RankingStockDetailChart.tsx에만
// 로컬로 있던 걸 모바일도 똑같이 쓸 수 있게 공통 모듈로 옮겼다(수칙 1-6).
export const CustomSupplyTooltip = ({ active, payload, label }: any) => {
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

// 🚨 [기능 추가 - 모바일 전용] 데스크톱은 캔들/4대주체/거래량 3개 팝업이 syncId로 동시에 뜨는데,
// 화면이 넓어서 세로로 겹치지 않는다. 모바일은 세 차트 사이 간격이 좁아 세 팝업이 동시에 뜨면
// 서로 겹쳐서 아래 팝업이 가려지는 문제가 실측으로 확인됐다(사용자 지적). 데스크톱과 똑같이
// "3개 다 따로 띄우기"가 아니라, 캔들/4대주체/거래량 정보를 한 카드에 전부 모아 캔들 차트 쪽
// 팝업 하나만 띄우는 방식으로 해결한다(수칙 1-6: CustomCandleTooltip/CustomSupplyTooltip/
// CustomDailyVolumeTooltip 각각의 계산·포맷 로직을 그대로 재사용, 새 공식 없음). 나머지 두
// 차트는 Tooltip content를 null로 비우고 cursor(세로 기준선)만 유지해 "어느 날짜가 선택됐는지"는
// 계속 3개 차트에 다 표시되게 한다.
export const CustomUnifiedMobileTooltip = ({ active, payload, label, priceLabel = '원' }: any) => {
  if (!active || !payload || !payload.length) return null;
  const dataPoint = payload[0]?.payload;
  if (!dataPoint) return null;

  const openPrice = dataPoint.openPrice ?? dataPoint.closePrice;
  const highPrice = dataPoint.highPrice ?? dataPoint.closePrice;
  const lowPrice = dataPoint.lowPrice ?? dataPoint.closePrice;
  const closePrice = dataPoint.closePrice;
  const isUp = closePrice >= openPrice;
  const intradayRate = openPrice > 0 ? ((closePrice - openPrice) / openPrice) * 100 : 0;
  const fmtPrice = (v: number) => Math.round(v).toLocaleString();
  const fmtAmt = (v: number) => {
    const sign = v >= 0 ? '+' : '';
    return Math.abs(v) >= 100 ? `${sign}${(v / 100).toFixed(1)}억` : `${sign}${v.toLocaleString()}백만`;
  };
  const volume = dataPoint.volume || 0;
  const volMa20 = dataPoint.volMa20 || 0;
  const volRatioVsAvg = volMa20 > 0 ? Math.round((volume / volMa20) * 100) : null;

  return (
    <div className="bg-white/95 dark:bg-[#1a1e29]/95 border border-slate-200 dark:border-[#2a2e39] p-2.5 rounded-lg shadow-xl text-xs space-y-1 z-50 font-sans backdrop-blur-sm min-w-[195px] w-auto whitespace-nowrap pointer-events-none">
      <div className="font-bold border-b border-slate-200 dark:border-slate-700/80 pb-1 text-slate-800 dark:text-slate-100 flex justify-between items-center text-[11px] gap-3">
        <span>📅 {dataPoint.formattedDate ? `${dataPoint.formattedDate} ` : ''}{label}</span>
        <span className="text-[10px] text-slate-400 font-mono">{isUp ? `양봉 🔴 (+${intradayRate.toFixed(2)}%)` : `음봉 🔵 (${intradayRate.toFixed(2)}%)`}</span>
      </div>

      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">최고가:</span>
        <span className="font-mono font-bold text-red-500">{fmtPrice(highPrice)}{priceLabel}</span>
      </div>
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">시가:</span>
        <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{fmtPrice(openPrice)}{priceLabel}</span>
      </div>
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">종가:</span>
        <span className="font-mono font-bold text-slate-900 dark:text-white">{fmtPrice(closePrice)}{priceLabel}</span>
      </div>
      <div className="flex justify-between items-center text-[11px] gap-3">
        <span className="text-slate-500 dark:text-slate-400 font-medium">최저가:</span>
        <span className="font-mono font-bold text-blue-500">{fmtPrice(lowPrice)}{priceLabel}</span>
      </div>

      <div className="pt-1.5 border-t border-slate-200 dark:border-slate-700/80 space-y-1 text-[10px]">
        <div className="flex justify-between items-center gap-3">
          <span className="text-slate-500 dark:text-slate-400 font-medium">🟢 추세:</span>
          <span className="font-bold text-emerald-600 dark:text-emerald-400">{dataPoint.trendStatus || '이평선 수렴'}</span>
        </div>
        <div className="flex justify-between items-center gap-3">
          <span className="text-orange-600 dark:text-orange-400 font-medium">🛡️ 1차 지지 (20일선):</span>
          <span className="font-mono font-bold text-orange-500">
            {dataPoint.ma20 !== undefined && dataPoint.ma20 !== null ? `${fmtPrice(dataPoint.ma20)}${priceLabel}` : '-'}
          </span>
        </div>
      </div>

      <div className="pt-1.5 border-t border-slate-200 dark:border-slate-700/80 space-y-0.5 text-[10px]">
        <div className="flex justify-between items-center gap-3">
          <span className="text-orange-500 font-bold">🟠 외국인:</span>
          <span className={`font-mono font-bold ${(dataPoint.foreignNetBuyAmt ?? 0) >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmtAmt(dataPoint.foreignNetBuyAmt ?? 0)}</span>
        </div>
        <div className="flex justify-between items-center gap-3">
          <span className="text-teal-500 font-bold">🟢 기관:</span>
          <span className={`font-mono font-bold ${(dataPoint.organNetBuyAmt ?? 0) >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmtAmt(dataPoint.organNetBuyAmt ?? 0)}</span>
        </div>
        <div className="flex justify-between items-center gap-3">
          <span className="text-amber-500 font-bold">🟡 프로그램:</span>
          <span className={`font-mono font-bold ${(dataPoint.programNetBuyAmt ?? 0) >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{fmtAmt(dataPoint.programNetBuyAmt ?? 0)}</span>
        </div>
      </div>

      <div className="pt-1.5 border-t border-slate-200 dark:border-slate-700/80 space-y-0.5 text-[10px]">
        <div className="flex justify-between items-center gap-3">
          <span className="text-slate-500 dark:text-slate-400 font-medium">📊 거래량:</span>
          <span className="font-mono font-bold text-slate-900 dark:text-white">{volume.toLocaleString()}주</span>
        </div>
        {volRatioVsAvg !== null && (
          <div className="flex justify-between items-center gap-3">
            <span className="text-slate-500 dark:text-slate-400 font-medium">20일 평균 대비:</span>
            <span className={`font-mono font-bold ${volRatioVsAvg >= 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>{volRatioVsAvg}%</span>
          </div>
        )}
      </div>
    </div>
  );
};

// 일간 거래량 차트 공용 팝업 - RankingStockDetailChart.tsx에만 있던 걸 모바일도 똑같이 쓸 수 있게
// 공통 모듈로 옮겼다(수칙 1-6, 데스크톱은 이 안에 로컬로 중복 구현돼 있던 것을 이걸로 대체).
export const CustomDailyVolumeTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || !payload.length) return null;
  const dataPoint = payload[0]?.payload;
  if (!dataPoint) return null;

  const volume = dataPoint.volume || 0;
  const volMa20 = dataPoint.volMa20 || 0;
  const isUp = (dataPoint.closePrice ?? 0) >= (dataPoint.openPrice ?? 0);
  // 오늘 거래량이 20일 평균 대비 몇 %인지 - "기준선 위로 올라왔는지"를 숫자로도 바로 확인
  const ratioVsAvg = volMa20 > 0 ? Math.round((volume / volMa20) * 100) : null;

  return (
    <div className="bg-white/95 dark:bg-[#1e222d]/95 backdrop-blur-md p-2.5 rounded-xl border border-slate-200 dark:border-[#2a2e39] shadow-xl text-xs space-y-1 z-50">
      <div className="font-bold text-slate-700 dark:text-slate-200 pb-1 border-b border-slate-100 dark:border-slate-800">
        {label} 거래량
      </div>
      <div className="flex justify-between items-center gap-3">
        <span className={`font-bold flex items-center gap-1 ${isUp ? 'text-red-500' : 'text-blue-500'}`}>
          {isUp ? '🔴 양봉' : '🔵 음봉'}
        </span>
        <span className="font-mono font-bold text-slate-900 dark:text-white">{volume.toLocaleString()}주</span>
      </div>
      {volMa20 > 0 && (
        <div className="flex justify-between items-center gap-3 pt-1 border-t border-slate-100 dark:border-slate-800">
          <span className="font-semibold text-amber-600 dark:text-amber-400">20일 평균</span>
          <span className="font-mono text-slate-600 dark:text-slate-300">{volMa20.toLocaleString()}주</span>
        </div>
      )}
      {ratioVsAvg !== null && (
        <div className="flex justify-between items-center gap-3">
          <span className="font-semibold text-slate-500 dark:text-slate-400">평균 대비</span>
          <span className={`font-mono font-bold ${ratioVsAvg >= 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
            {ratioVsAvg}%{ratioVsAvg >= 100 ? ' (기준선 이상)' : ''}
          </span>
        </div>
      )}
    </div>
  );
};
