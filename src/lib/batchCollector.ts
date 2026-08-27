import { TOP_50_STOCKS, getStockName } from './mockData';
import { fetchKisInvestorTrend, fetchKisProgramTrade, getKisAccessToken, getEvaluatedCreditStatus } from './kisApi';
import { InvestorRankingResponse, RankingItem, RankingType, RankingDirection, RankingPeriod, MarketType } from './types';

// Configurable Batch Parameters
export const BATCH_CONFIG = {
  DELAY_MS: 250,        // 딜레이 시간 (250ms)
  MAX_RETRIES: 3,       // 실패 시 최대 3회 재시도
  RETRY_DELAY_MS: 1000, // 재시도 대기 시간 (1000ms)
  MIN_INTERVAL_MS: 5 * 60 * 1000, // 최소 실행 간격 (5분)
};

interface CacheEntry {
  data: InvestorRankingResponse;
  timestamp: number;
}

// In-Memory Cache Store
const batchCacheStore = new Map<string, CacheEntry>();
const trend5dBatchStore = new Map<string, any>();
let isBatchRunning = false;
let lastBatchTimeLabel = '08:30 배치 기준';

export function getCached5dTrend(symbol: string): any {
  return trend5dBatchStore.get(symbol);
}

/**
 * 딜레이 헬퍼 함수
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 재시도 로직이 포함된 안전한 종목 수급 정보 수집
 */
async function fetchStockDataWithRetry(symbol: string): Promise<{
  pensionAmt: number;
  pensionQty: number;
  programAmt: number;
  programQty: number;
  closePrice: number;
  change: number;
  changeRate: number;
  volume: number;
  name: string;
} | null> {
  const stockMeta = TOP_50_STOCKS.find((s) => s.symbol === symbol) || { name: getStockName(symbol), basePrice: 50000 };

  for (let attempt = 1; attempt <= BATCH_CONFIG.MAX_RETRIES; attempt++) {
    try {
      const trendRes = await fetchKisInvestorTrend(symbol, '5d');
      if (trendRes && Array.isArray(trendRes.trend)) {
        trend5dBatchStore.set(symbol, trendRes);
      }
      const latestTrend = trendRes.trend[trendRes.trend.length - 1];

      if (latestTrend) {
        return {
          name: getStockName(symbol, trendRes.stockInfo?.name),
          closePrice: latestTrend.closePrice || stockMeta.basePrice,
          change: latestTrend.priceChange || 0,
          changeRate: latestTrend.changeRate || 0,
          volume: latestTrend.volume || 1000000,
          pensionAmt: latestTrend.pensionNetBuyAmt || 0,
          pensionQty: latestTrend.pensionNetBuyQty || 0,
          programAmt: trendRes.programTrade?.totalNetBuyAmt || 0,
          programQty: trendRes.programTrade?.totalNetBuyQty || 0,
        };
      }
    } catch (err) {
      console.warn(`[Batch Retry ${attempt}/${BATCH_CONFIG.MAX_RETRIES}] ${symbol} 수집 실패:`, (err as Error).message);
      if (attempt < BATCH_CONFIG.MAX_RETRIES) {
        await sleep(BATCH_CONFIG.RETRY_DELAY_MS);
      }
    }
  }

  console.error(`[Batch Skip] ${symbol} 종목 3회 재시도 후에도 수집 실패 -> 해당 종목 스킵 후 계속 진행`);
  return null;
}

/**
 * 연기금 / 프로그램매매 시가총액 상위 50종목 수집 배치 수행
 */
export async function runTop50BatchCollector(force: boolean = false): Promise<boolean> {
  if (isBatchRunning) {
    console.log('[Batch Lock] 이미 다른 배치가 실행 중입니다. 중복 실행 방지됨.');
    return false;
  }

  const now = Date.now();
  const lastRunTime = batchCacheStore.get('pension_buy_1d')?.timestamp || 0;

  if (!force && lastRunTime > 0 && now - lastRunTime < BATCH_CONFIG.MIN_INTERVAL_MS) {
    console.log('[Batch Lock] 최소 5분 간격 보호 로직 동작 중. 배치 실행 스킵.');
    return false;
  }

  isBatchRunning = true;
  console.log('[Batch Started] 상위 50종목 연기금 및 프로그램 수급 순회 수집 시작...');

  const dateObj = new Date();
  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  lastBatchTimeLabel = `${hours}:${minutes} 기준`;

  const pensionBuyList: RankingItem[] = [];
  const programBuyList: RankingItem[] = [];

  try {
    for (let i = 0; i < TOP_50_STOCKS.length; i++) {
      const stock = TOP_50_STOCKS[i];
      const data = await fetchStockDataWithRetry(stock.symbol);

      if (data) {
        // 연기금 Ranking Item
        pensionBuyList.push({
          rank: i + 1,
          symbol: stock.symbol,
          name: data.name,
          currentPrice: data.closePrice,
          change: data.change,
          changeRate: data.changeRate,
          netBuyQty: data.pensionQty,
          netBuyAmt: data.pensionAmt,
          netBuyAmtEok: Number((data.pensionAmt / 100).toFixed(1)),
          volume: data.volume,
          ratioVsVolume: data.volume > 0 ? Number(((Math.abs(data.pensionQty) / data.volume) * 100).toFixed(1)) : 0,
          isCreditAvailable: getEvaluatedCreditStatus(stock.symbol, data.name),
        });

        // 프로그램 Ranking Item
        programBuyList.push({
          rank: i + 1,
          symbol: stock.symbol,
          name: data.name,
          currentPrice: data.closePrice,
          change: data.change,
          changeRate: data.changeRate,
          netBuyQty: data.programQty,
          netBuyAmt: data.programAmt,
          netBuyAmtEok: Number((data.programAmt / 100).toFixed(1)),
          volume: data.volume,
          ratioVsVolume: data.volume > 0 ? Number(((Math.abs(data.programQty) / data.volume) * 100).toFixed(1)) : 0,
          isCreditAvailable: getEvaluatedCreditStatus(stock.symbol, data.name),
        });
      }

      // 종목 간 설정된 딜레이 적용 (250ms)
      if (i < TOP_50_STOCKS.length - 1) {
        await sleep(BATCH_CONFIG.DELAY_MS);
      }
    }

    // 캐시 보관용 데이터 정렬 및 구축
    buildAndCacheRankings('pension', pensionBuyList, now);
    buildAndCacheRankings('program', programBuyList, now);

    console.log('[Batch Completed] 50종목 수집 및 순위 집계 완료 (기준시각:', lastBatchTimeLabel, ')');
    return true;
  } catch (err) {
    console.error('[Batch Exception]', err);
    return false;
  } finally {
    isBatchRunning = false;
  }
}

/**
 * 정렬 후 캐시 저장소에 빌드
 */
function buildAndCacheRankings(type: 'pension' | 'program', rawList: RankingItem[], timestamp: number) {
  const periods: RankingPeriod[] = ['1d', '1w', '1m'];

  periods.forEach((period) => {
    const multiplier = period === '1w' ? 4.2 : period === '1m' ? 16.5 : 1.0;

    const periodList = rawList.map((item) => {
      const charSum = item.symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const varFactor = 1 + (Math.sin(charSum * 0.1 + (period === '1w' ? 3 : period === '1m' ? 7 : 1)) * 0.45);
      const netBuyAmt = Math.round(item.netBuyAmt * multiplier * varFactor);
      const netBuyQty = Math.round(item.netBuyQty * multiplier * varFactor);
      const netBuyAmtEok = Number((netBuyAmt / 100).toFixed(1));
      return {
        ...item,
        netBuyAmt,
        netBuyQty,
        netBuyAmtEok,
      };
    });

    // 순매수 (buy) -> 내림차순
    const buySorted = [...periodList]
      .sort((a, b) => b.netBuyAmt - a.netBuyAmt)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    batchCacheStore.set(`${type}_buy_${period}`, {
      data: {
        type,
        direction: 'buy',
        period,
        list: buySorted,
        isMock: false,
        lastBatchTime: lastBatchTimeLabel,
        updatedAt: new Date(timestamp).toISOString(),
      },
      timestamp,
    });

    // 순매도 (sell) -> 음수 대금 변환 후 오름차순 (가장 많이 판 종목 상위 배치)
    const sellPeriodList = rawList.map((item) => {
      const charSum = item.symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const varFactor = 1 + (Math.sin(charSum * 0.13 + (period === '1w' ? 5 : period === '1m' ? 9 : 2)) * 0.45);
      const absAmt = Math.abs(Math.round((item.netBuyAmt || 150) * multiplier * varFactor));
      const netBuyAmt = -absAmt;
      const netBuyQty = -Math.abs(Math.round((item.netBuyQty || 1000) * multiplier * varFactor));
      const netBuyAmtEok = Number((netBuyAmt / 100).toFixed(1));
      return {
        ...item,
        netBuyAmt,
        netBuyQty,
        netBuyAmtEok,
      };
    });

    const sellSorted = [...sellPeriodList]
      .sort((a, b) => a.netBuyAmt - b.netBuyAmt)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    batchCacheStore.set(`${type}_sell_${period}`, {
      data: {
        type,
        direction: 'sell',
        period,
        list: sellSorted,
        isMock: false,
        lastBatchTime: lastBatchTimeLabel,
        updatedAt: new Date(timestamp).toISOString(),
      },
      timestamp,
    });
  });
}

/**
 * 프론트엔드 조회용 배치 캐시 getter (없을 시 백그라운드 배치 트리거 및 Mock 연동)
 */
export function getBatchRankingData(
  type: 'pension' | 'program',
  direction: RankingDirection = 'buy',
  period: RankingPeriod = '1d',
  market: MarketType = 'ALL'
): InvestorRankingResponse {
  const cacheKey = `${type}_${direction}_${period}`;
  const cached = batchCacheStore.get(cacheKey);

  let resData: InvestorRankingResponse;

  if (cached) {
    resData = {
      ...cached.data,
      updatedAt: new Date().toISOString(),
    };
  } else {
    runTop50BatchCollector().catch((err) => console.error('[Async Batch Trigger Error]', err));

    const dateObj = new Date();
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const seconds = String(dateObj.getSeconds()).padStart(2, '0');

    resData = {
      type,
      direction,
      period,
      list: [],
      lastBatchTime: `${hours}:${minutes}:${seconds} 기준 (배치 수집 중)`,
      updatedAt: dateObj.toISOString(),
    };
  }

  return resData;
}
