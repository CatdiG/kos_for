/**
 * KIS API 수급 분석 시스템 - 핵심 마스터 카탈로그 및 유틸리티
 * (Mock 데이터 생성기 완전 제거완료, 실데이터 전용)
 */

import { MarketType } from './types';
import { TOP_300_STOCKS } from './stockUniverse300';

export function getSettledAsOfDateLabel(lastTradeDate?: string): string {
  if (lastTradeDate && lastTradeDate.length === 8) {
    const month = parseInt(lastTradeDate.substring(4, 6), 10);
    const day = parseInt(lastTradeDate.substring(6, 8), 10);
    return `(${month}/${day} 기준)`;
  }
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  const hour = kstDate.getHours();
  const minute = kstDate.getMinutes();
  const timeNum = hour * 100 + minute;
  const dayOfWeek = kstDate.getDay();
  let day = kstDate.getDate();
  let month = kstDate.getMonth() + 1;

  // 장 개장 전(09:00 이전) 또는 주말일 때만 직전 유효 거래일로 감산
  if (dayOfWeek === 6) {
    day -= 1; // 토요일 ➔ 금요일
  } else if (dayOfWeek === 0) {
    day -= 2; // 일요일 ➔ 금요일
  } else if (timeNum < 900) {
    // 평일 개장 전 ➔ 직전 거래일
    if (dayOfWeek === 1) {
      day -= 3; // 월요일 개장 전 ➔ 금요일
    } else {
      day -= 1;
    }
  }

  if (day <= 0) {
    month -= 1;
    if (month <= 0) month = 12;
    const prevMonthDays = new Date(kstDate.getFullYear(), month, 0).getDate();
    day += prevMonthDays;
  }

  return `(${month}/${day} 기준)`;
}

/**
 * KRX 가집계 공식 공표 차수 단일 판정 공통 함수 (수칙 1-6 단일화)
 * 규정: 09:30 1차(외인), 10:00 1차(종합), 11:30 2차, 13:20 3차, 14:30 4차, 15:35 장마감
 */
export function getKrxEstimateSlotInfo(customKstDate?: Date) {
  const now = customKstDate || new Date();
  const utc = now.getTime() + (customKstDate ? 0 : now.getTimezoneOffset() * 60000);
  const kst = customKstDate || new Date(utc + 9 * 60 * 60000);
  const hour = kst.getHours();
  const minute = kst.getMinutes();
  const timeNum = hour * 100 + minute;
  const dayOfWeek = kst.getDay();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 900 && timeNum < 1530;
  const isWeekdayPostMarket = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 1530;

  const krxSchedule = [
    { step: '1차(외인)', time: '09:30', timeNum: 930 },
    { step: '1차(종합)', time: '10:00', timeNum: 1000 },
    { step: '2차', time: '11:30', timeNum: 1130 },
    { step: '3차', time: '13:20', timeNum: 1320 },
    { step: '4차', time: '14:30', timeNum: 1430 },
    { step: '장마감', time: '15:35', timeNum: 1535 },
  ];

  // 현재 시각 기준 이미 경과한 최신 공표 차수
  const passedSlot = [...krxSchedule].reverse().find((s) => timeNum >= s.timeNum);
  const nextSlot = krxSchedule.find((s) => timeNum < s.timeNum);

  const slotTime = passedSlot ? passedSlot.time : (timeNum < 930 ? '09:00' : '09:30');
  const slotStep = passedSlot ? passedSlot.step : '장 개장 전';
  const nextTime = nextSlot ? nextSlot.time : '내일 09:30';

  const formattedEstimateLabel = isMarketOpen
    ? `당일 잠정 (${slotTime} 추정)`
    : (isWeekdayPostMarket ? `당일 최종잠정 (14:30 기준)` : getSettledAsOfDateLabel());

  return {
    schedule: krxSchedule,
    currentSlot: {
      step: slotStep,
      time: slotTime,
      timeNum: passedSlot ? passedSlot.timeNum : 900,
      label: `${slotTime} 기준`,
    },
    nextSlotTime: nextTime,
    isMarketOpen,
    isWeekdayPostMarket,
    timeStr,
    timeNum,
    formattedEstimateLabel,
  };
}

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

  // TOP_300_STOCKS(코스피+코스닥 시총 상위 300종목 풀)에도 있는지 마지막으로 확인 - 219종목대 등
  // TOP_50/PRESET엔 없지만 이월(carriedOver) 경로로 유입되는 종목들의 이름이 숫자 코드 그대로
  // 저장/노출되던 버그(319660 피에스케이, 214370 케어젠 등)를 근본적으로 막기 위함.
  const top300 = TOP_300_STOCKS.find((s) => s.symbol === symbol);
  if (top300) return top300.name;

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
 * 액면분할/무상감자 등으로 전일 대비 종가가 비정상적으로 급변(60% 미만 급락 또는 167% 초과 급등)한
 * 지점을 감지해, 가장 최근에 발생한 "분할 경계" 인덱스를 반환한다.
 * 이 인덱스 이전 데이터는 옛 가격 스케일이 섞여있어 이동평균/이격도/전저점 계산에 쓰면 왜곡되므로,
 * 호출부에서 반드시 이 인덱스 이후 데이터만 사용해야 한다. 분할 이력이 없으면 0(전체 배열 사용).
 * (과거 가격을 임의 배율로 보정하는 가짜 보간은 하지 않고, 오염 구간 자체를 제외하는 방식)
 */
export function findSplitSafeStartIndex(closes: (number | null | undefined)[]): number {
  if (!closes || closes.length < 2) return 0;
  for (let i = closes.length - 1; i >= 1; i--) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!prev || !cur || prev <= 0 || cur <= 0) continue;
    const ratio = cur / prev;
    if (ratio > 1.67 || ratio < 0.6) {
      return i;
    }
  }
  return 0;
}

/**
 * 계산된 가격(이동평균 기반 과열가/침체가 등)을 실제 KRX 호가단위에 맞춰 반올림한다.
 * (예: 2,000~5,000원 구간은 5원 단위, 5,000~20,000원 구간은 10원 단위 등 - 2023.1 개정 기준)
 * 실제로 호가에 존재하지 않는 가격(예: 4,456원)이 화면에 뜨는 것을 방지한다.
 */
export function roundToKrxTick(price: number): number {
  if (!price || price <= 0) return price;
  let tick: number;
  if (price < 2000) tick = 1;
  else if (price < 5000) tick = 5;
  else if (price < 20000) tick = 10;
  else if (price < 50000) tick = 50;
  else if (price < 200000) tick = 100;
  else if (price < 500000) tick = 500;
  else tick = 1000;
  return Math.round(price / tick) * tick;
}

/**
 * 당일 거래량이 최근 20거래일(당일 제외) 평균 거래량 대비 몇 %인지 산출한다.
 * (단기과열 상태에서 세력매집/설거지주의를 가르는 보조 지표 - 거래량 급증은 통상 매물 출회/분산 경고 신호)
 * 데이터가 6일 미만이면 의미있는 평균을 낼 수 없으므로 null 반환.
 */
export function computeRecentVolumeRatio(volumes: (number | null | undefined)[]): number | null {
  const valid = (volumes || []).map((v) => v || 0);
  if (valid.length < 6) return null;

  const today = valid[valid.length - 1];
  if (!today || today <= 0) return null;

  const priorWindow = valid.slice(Math.max(0, valid.length - 21), valid.length - 1).filter((v) => v > 0);
  if (priorWindow.length === 0) return null;

  const avgVolume = priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length;
  if (avgVolume <= 0) return null;

  return Number(((today / avgVolume) * 100).toFixed(1));
}

/**
 * 전 종목 통일 이동평균 추세 및 이격도 배지 산출 (Single Source of Truth)
 * volumeRatio: computeRecentVolumeRatio() 결과(당일 거래량/최근 20일 평균 거래량 ×100). 선택값 - 없으면 가격 구조만으로 판정.
 */
export function computeUnifiedStatusBadge(
  closePrice: number,
  ma5: number | null,
  ma20: number | null,
  ma60: number | null,
  volumeRatio?: number | null
): { shortBadge: string; badgeStyle: string } {
  if (!closePrice || !ma20) {
    return {
      shortBadge: '⚪ 이평선 수렴',
      badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700',
    };
  }

  const disparate20 = Number(((closePrice / ma20) * 100).toFixed(1));
  const disparate60 = ma60 ? Number(((closePrice / ma60) * 100).toFixed(1)) : 100;

  // 1. 🔵 바닥 반등 (60일선 대비 과락 후 20일선 단기 반등)
  if (disparate60 <= 90 && disparate20 >= 95.0) {
    return {
      shortBadge: '🔵 바닥 반등',
      badgeStyle: 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60 font-bold',
    };
  }
  // 2. 단기 과열 (20일선 이격도 105% 이상 또는 60일선 110% 이상)
  if (disparate20 >= 105 || disparate60 >= 110) {
    // 5일선이 20일선 위에 있고(정배열 지지) 20일선 위에서 매집/눌림목 지지 중인 경우
    const isStructureBullish = Boolean(ma5 && ma20 && ma5 >= ma20 && closePrice >= ma20);
    // 당일 거래량이 최근 20일 평균 대비 200%(2배) 이상 폭증하면, 구조가 살아있어도
    // 상투권 매물 출회(분산/설거지)의 전형적 신호로 보고 세력매집 판정에서 제외한다.
    const isVolumeSpike = volumeRatio !== null && volumeRatio !== undefined && volumeRatio >= 200;

    if (isStructureBullish && !isVolumeSpike) {
      return {
        shortBadge: '🔥 단기과열 (세력매집)',
        badgeStyle: 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 font-bold',
      };
    }
    return {
      shortBadge: '⚠️ 단기과열 (설거지주의)',
      badgeStyle: 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60 font-bold',
    };
  }
  // 3. 🟢 정배열 (5일선 >= 20일선 정배열 상승 추세 - 초입+확산 정석 통합)
  if (ma5 && ma5 >= ma20 && disparate20 >= 99.5) {
    return {
      shortBadge: '🟢 정배열',
      badgeStyle: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/60 font-bold',
    };
  }
  // 4. 🔴 역배열 (5일선 < 20일선 하락 및 조정 국면)
  if (ma5 && ma5 < ma20 && disparate20 < 97.0) {
    return {
      shortBadge: '🔴 역배열',
      badgeStyle: 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60 font-bold',
    };
  }

  // 5. ⚪ 이평선 수렴 (횡보 / 에너지 축적 관망 구간)
  return {
    shortBadge: '⚪ 이평선 수렴',
    badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700',
  };
}
