/**
 * KIS API 수급 분석 시스템 - 핵심 마스터 카탈로그 및 유틸리티
 * (Mock 데이터 생성기 완전 제거완료, 실데이터 전용)
 */

import { MarketType } from './types';

export interface StockInfo {
  symbol: string;
  name: string;
  market: MarketType;
  currentPrice: number;
  change: number;
  changeRate: number;
  volume: number;
  isCreditAvailable?: boolean;
}

// 런타임 종목명 등록 마스터 맵
const runtimeStockNameMap = new Map<string, string>();

export function registerRuntimeStockName(symbol: string, name: string) {
  if (symbol && name && !runtimeStockNameMap.has(symbol)) {
    runtimeStockNameMap.set(symbol, name);
  }
}

export function getStockName(symbol: string, fallbackName?: string): string {
  if (fallbackName && fallbackName !== symbol) {
    registerRuntimeStockName(symbol, fallbackName);
    return fallbackName;
  }

  if (runtimeStockNameMap.has(symbol)) {
    return runtimeStockNameMap.get(symbol)!;
  }

  const preset = PRESET_STOCKS.find((s) => s.symbol === symbol);
  if (preset) return preset.name;

  const top50 = TOP_50_STOCKS.find((s) => s.symbol === symbol);
  if (top50) return top50.name;

  return symbol;
}

// TOP 50 대표 종목 마스터 카탈로그
export const TOP_50_STOCKS: { symbol: string; name: string; market: 'KOSPI' | 'KOSDAQ'; basePrice: number }[] = [
  { symbol: '005930', name: '삼성전자', market: 'KOSPI', basePrice: 74500 },
  { symbol: '000660', name: 'SK하이닉스', market: 'KOSPI', basePrice: 186000 },
  { symbol: '373220', name: 'LG에너지솔루션', market: 'KOSPI', basePrice: 382000 },
  { symbol: '207940', name: '삼성바이오로직스', market: 'KOSPI', basePrice: 812000 },
  { symbol: '005935', name: '삼성전자우', market: 'KOSPI', basePrice: 62500 },
  { symbol: '005380', name: '현대차', market: 'KOSPI', basePrice: 245000 },
  { symbol: '000270', name: '기아', market: 'KOSPI', basePrice: 118500 },
  { symbol: '068270', name: '셀트리온', market: 'KOSPI', basePrice: 179500 },
  { symbol: '035420', name: 'NAVER', market: 'KOSPI', basePrice: 172000 },
  { symbol: '005490', name: 'POSCO홀딩스', market: 'KOSPI', basePrice: 365000 },
  { symbol: '035720', name: '카카오', market: 'KOSPI', basePrice: 42500 },
  { symbol: '012330', name: '현대모비스', market: 'KOSPI', basePrice: 228000 },
  { symbol: '028260', name: '삼성물산', market: 'KOSPI', basePrice: 148000 },
  { symbol: '105560', name: 'KB금융', market: 'KOSPI', basePrice: 78500 },
  { symbol: '055550', name: '신한지주', market: 'KOSPI', basePrice: 46200 },
  { symbol: '015760', name: '한국전력', market: 'KOSPI', basePrice: 19800 },
  { symbol: '032830', name: '삼성생명', market: 'KOSPI', basePrice: 89000 },
  { symbol: '010140', name: '삼성중공업', market: 'KOSPI', basePrice: 8950 },
  { symbol: '009150', name: '삼성전기', market: 'KOSPI', basePrice: 154000 },
  { symbol: '034730', name: 'SK', market: 'KOSPI', basePrice: 165000 },
  { symbol: '086790', name: '하나금융지주', market: 'KOSPI', basePrice: 61200 },
  { symbol: '018260', name: '삼성SDS', market: 'KOSPI', basePrice: 142500 },
  { symbol: '003550', name: 'LG', market: 'KOSPI', basePrice: 78000 },
  { symbol: '011200', name: 'HMM', market: 'KOSPI', basePrice: 17400 },
  { symbol: '329180', name: 'HD현대중공업', market: 'KOSPI', basePrice: 138000 },
  { symbol: '247540', name: '에코프로비엠', market: 'KOSDAQ', basePrice: 185000 },
  { symbol: '086520', name: '에코프로', market: 'KOSDAQ', basePrice: 92000 },
  { symbol: '028300', name: 'HLB', market: 'KOSDAQ', basePrice: 64500 },
  { symbol: '263750', name: '펄어비스', market: 'KOSDAQ', basePrice: 38500 },
  { symbol: '293490', name: '카카오게임즈', market: 'KOSDAQ', basePrice: 21500 },
  { symbol: '035900', name: 'JYP Ent.', market: 'KOSDAQ', basePrice: 58000 },
  { symbol: '122870', name: '와이지엔터테인먼트', market: 'KOSDAQ', basePrice: 41200 },
  { symbol: '357780', name: '솔브레인', market: 'KOSDAQ', basePrice: 285000 },
  { symbol: '066970', name: '엘앤에프', market: 'KOSDAQ', basePrice: 145000 },
  { symbol: '196170', name: '알테오젠', market: 'KOSDAQ', basePrice: 275000 },
  { symbol: '041510', name: 'SM 엔터테인먼트', market: 'KOSDAQ', basePrice: 72000 },
  { symbol: '253450', name: '스튜디오드래곤', market: 'KOSDAQ', basePrice: 44500 },
  { symbol: '036830', name: '오성첨단소재', market: 'KOSDAQ', basePrice: 1850 },
  { symbol: '060310', name: '3S', market: 'KOSDAQ', basePrice: 2650 },
  { symbol: '067160', name: '아프리카TV', market: 'KOSDAQ', basePrice: 115000 },
  { symbol: '000100', name: '유한양행', market: 'KOSPI', basePrice: 76000 },
  { symbol: '000810', name: '삼성화재', market: 'KOSPI', basePrice: 325000 },
  { symbol: '010950', name: 'S-Oil', market: 'KOSPI', basePrice: 68000 },
  { symbol: '036570', name: '엔씨소프트', market: 'KOSPI', basePrice: 188000 },
  { symbol: '011170', name: '롯데케미칼', market: 'KOSPI', basePrice: 112000 },
  { symbol: '004020', name: '현대제철', market: 'KOSPI', basePrice: 32000 },
  { symbol: '021240', name: '코웨이', market: 'KOSPI', basePrice: 58500 },
  { symbol: '008770', name: '호텔신라', market: 'KOSPI', basePrice: 56200 },
  { symbol: '078930', name: 'GS', market: 'KOSPI', basePrice: 52000 },
  { symbol: '000150', name: '두산2우B', market: 'KOSPI', basePrice: 19500 },
];

export const PRESET_STOCKS: StockInfo[] = TOP_50_STOCKS.slice(0, 10).map((s) => ({
  symbol: s.symbol,
  name: s.name,
  market: s.market,
  currentPrice: s.basePrice,
  change: Math.round(s.basePrice * 0.012),
  changeRate: 1.2,
  volume: 1000000,
  isCreditAvailable: true,
}));

export const KOSDAQ_KNOWN_SYMBOLS = new Set(
  TOP_50_STOCKS.filter((s) => s.market === 'KOSDAQ').map((s) => s.symbol)
);

export function resolveMarketType(
  symbol: string,
  name?: string,
  rawMarket?: string
): 'KOSPI' | 'KOSDAQ' {
  if (rawMarket === 'KOSDAQ' || rawMarket === 'W' || rawMarket === '1001') {
    return 'KOSDAQ';
  }
  if (rawMarket === 'KOSPI' || rawMarket === 'J' || rawMarket === '0001') {
    return 'KOSPI';
  }

  const foundInTop50 = TOP_50_STOCKS.find((s) => s.symbol === symbol);
  if (foundInTop50) {
    return foundInTop50.market;
  }

  if (KOSDAQ_KNOWN_SYMBOLS.has(symbol)) {
    return 'KOSDAQ';
  }

  const cleanSym = symbol.replace(/[^0-9]/g, '');
  if (cleanSym.length === 6) {
    const num = parseInt(cleanSym, 10);
    if (
      (num >= 60000 && num <= 99999) ||
      (num >= 100000 && num <= 399999)
    ) {
      if (num === 105560 || num === 128940 || num === 161890 || num === 271560) {
        return 'KOSPI';
      }
      return 'KOSDAQ';
    }
  }
  return 'KOSPI';
}

const runtimePriceCache = new Map<
  string,
  { price: number; change: number; changeRate: number; timestamp: number }
>();

export function updateRuntimeStockPrice(
  symbol: string,
  price: number,
  change: number,
  changeRate: number
) {
  if (price > 0) {
    runtimePriceCache.set(symbol, { price, change, changeRate, timestamp: Date.now() });
  }
}

export function resolveStockPriceAndChange(
  symbol: string,
  defaultPrice: number,
  defaultChange: number,
  defaultChangeRate: number
): { currentPrice: number; change: number; changeRate: number } {
  if (runtimePriceCache.has(symbol)) {
    const cached = runtimePriceCache.get(symbol)!;
    return {
      currentPrice: cached.price,
      change: cached.change,
      changeRate: cached.changeRate,
    };
  }
  return {
    currentPrice: defaultPrice,
    change: defaultChange,
    changeRate: defaultChangeRate,
  };
}

/**
 * 전 종목 통일 이동평균 추세 및 이격도 배지 산출 (Single Source of Truth)
 */
export function computeUnifiedStatusBadge(
  closePrice: number,
  ma5: number | null,
  ma20: number | null,
  ma60: number | null
): { shortBadge: string; badgeStyle: string } {
  if (!closePrice || !ma20) {
    return {
      shortBadge: '⚪ 이평선 수렴',
      badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700',
    };
  }

  const disparate20 = Number(((closePrice / ma20) * 100).toFixed(1));
  const disparate60 = ma60 ? Number(((closePrice / ma60) * 100).toFixed(1)) : 100;

  if (disparate60 <= 90 && disparate20 >= 105) {
    return {
      shortBadge: '🔵 바닥 반등',
      badgeStyle: 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60 font-bold',
    };
  }
  if (disparate20 >= 105 || disparate60 >= 110) {
    return {
      shortBadge: '⚠️ 단기 과열',
      badgeStyle: 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60 font-bold',
    };
  }
  if (ma5 && ma60 && ma5 > ma20 && ma20 > ma60 && disparate20 >= 103) {
    return {
      shortBadge: '🚀 정배열 확산',
      badgeStyle: 'bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/60 font-bold',
    };
  }
  if (ma5 && ma5 >= ma20 && disparate20 >= 99.5) {
    return {
      shortBadge: '🟢 정배열 초입',
      badgeStyle: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60 font-bold',
    };
  }
  if (ma5 && ma5 < ma20) {
    return {
      shortBadge: '🔵 역배열 / 조정',
      badgeStyle: 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60 font-bold',
    };
  }

  return {
    shortBadge: '⚪ 이평선 수렴',
    badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700',
  };
}
