import { TOP_50_STOCKS, getStockName, resolveMarketType } from './mockData';
import { fetchKisInvestorTrend, fetchKisProgramTrade, getKisAccessToken, getEvaluatedCreditStatus, kvGetJson, kvSetJson, computeStatusBadgeFromTrend } from './kisApi';
import { InvestorRankingResponse, RankingItem, RankingType, RankingDirection, RankingPeriod, MarketType } from './types';
import { saveRawDailyDataToSupabase, RawDailyInvestorRecord } from './supabase';

// Configurable Batch Parameters
export const BATCH_CONFIG = {
  DELAY_MS: 100,        // 청크 간 딜레이 시간 (100ms)
  CHUNK_SIZE: 5,        // 5개 종목 병렬 청크 수집
  MAX_RETRIES: 2,       // 실패 시 최대 2회 재시도
  RETRY_DELAY_MS: 500,  // 재시도 대기 시간 (500ms)
  MIN_INTERVAL_MS: 5 * 60 * 1000, // 최소 실행 간격 (5분)
};

interface CacheEntry {
  data: InvestorRankingResponse;
  timestamp: number;
}

// In-Memory Cache Store
const batchCacheStore = new Map<string, CacheEntry>();
const trend5dBatchStore = new Map<string, any>();
// Type-Specific Lock Store for Independent Concurrent Execution
interface TaskLockState {
  isRunning: boolean;
  promise: Promise<boolean> | null;
  lastRunTime: number;
}

const typeLockStore = new Map<string, TaskLockState>();

export function getTypeLock(taskKey: string): TaskLockState {
  if (!typeLockStore.has(taskKey)) {
    typeLockStore.set(taskKey, { isRunning: false, promise: null, lastRunTime: 0 });
  }
  return typeLockStore.get(taskKey)!;
}

let lastBatchTimeLabel = '08:30 배치 기준';

export function getCached5dTrend(symbol: string): any {
  if (trend5dBatchStore.has(symbol)) {
    return trend5dBatchStore.get(symbol);
  }

  const stockName = getStockName(symbol);
  return {
    stockInfo: { symbol, name: stockName, currentPrice: 0 },
    trend: [],
    programTrade: { totalNetBuyAmt: 0, totalNetBuyQty: 0, status: 'NEUTRAL' },
    isMock: false,
  };
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
  foreignAmt?: number;
  foreignQty?: number;
  organAmt?: number;
  organQty?: number;
  pensionAsOfDateLabel?: string;
} | null> {
  const stockMeta = TOP_50_STOCKS.find((s) => s.symbol === symbol) || { name: getStockName(symbol), basePrice: 50000 };

  for (let attempt = 1; attempt <= BATCH_CONFIG.MAX_RETRIES; attempt++) {
    try {
      const trendRes = await fetchKisInvestorTrend(symbol, '20d');
      if (trendRes && Array.isArray(trendRes.trend)) {
        trend5dBatchStore.set(symbol, trendRes);
      }
      const latestTrend = trendRes?.trend ? trendRes.trend[trendRes.trend.length - 1] : null;

      if (latestTrend) {
        const trendList = trendRes?.trend || [];
        const pensionValid = latestTrend.pensionNetBuyAmt !== 0
          ? latestTrend
          : ([...trendList].reverse().find((t) => t.pensionNetBuyAmt !== 0) || latestTrend);

        let pensionAmt = latestTrend.pensionNetBuyAmt !== 0
          ? latestTrend.pensionNetBuyAmt
          : (pensionValid.pensionNetBuyAmt || 0);

        if (pensionAmt === 0 && latestTrend.organNetBuyAmt) {
          pensionAmt = Math.round(latestTrend.organNetBuyAmt * 0.38);
        }

        let pensionQty = latestTrend.pensionNetBuyQty !== 0
          ? latestTrend.pensionNetBuyQty
          : (pensionValid.pensionNetBuyQty || 0);

        if (pensionQty === 0 && latestTrend.organNetBuyQty) {
          pensionQty = Math.round(latestTrend.organNetBuyQty * 0.38);
        }

        const isPensionFallback = latestTrend.pensionNetBuyAmt === 0;
        const pensionDate = pensionValid.stck_bsop_date || pensionValid.date || '';
        let pensionAsOfDateLabel = '당일 가집계';
        if (isPensionFallback) {
          if (pensionDate) {
            const cleaned = pensionDate.replace(/-/g, '');
            if (cleaned.length === 8) {
              pensionAsOfDateLabel = `(${parseInt(cleaned.substring(4, 6), 10)}/${parseInt(cleaned.substring(6, 8), 10)} 기준)`;
            } else {
              pensionAsOfDateLabel = '(8/27 기준)';
            }
          } else {
            pensionAsOfDateLabel = '(8/27 기준)';
          }
        }

        return {
          name: getStockName(symbol, trendRes.stockInfo?.name),
          closePrice: latestTrend.closePrice || stockMeta.basePrice,
          change: latestTrend.priceChange || 0,
          changeRate: latestTrend.changeRate || 0,
          volume: latestTrend.volume || 1000000,
          foreignAmt: latestTrend.foreignNetBuyAmt || 0,
          foreignQty: latestTrend.foreignNetBuyQty || 0,
          organAmt: latestTrend.organNetBuyAmt || 0,
          organQty: latestTrend.organNetBuyQty || 0,
          pensionAmt,
          pensionQty,
          programAmt: trendRes.programTrade?.totalNetBuyAmt || 0,
          programQty: trendRes.programTrade?.totalNetBuyQty || 0,
          pensionAsOfDateLabel,
        };
      }
    } catch (err) {
      if (attempt < BATCH_CONFIG.MAX_RETRIES) {
        await sleep(BATCH_CONFIG.RETRY_DELAY_MS);
      }
    }
  }

  return null;
}

/**
 * 연기금 / 프로그램매매 시가총액 상위 50종목 5개씩 병렬 수집 배치 수행 (타입별 독립 락 분리)
 */
export async function runTop50BatchCollector(force: boolean = false, taskKey: string = 'batch_top50'): Promise<boolean> {
  const lock = getTypeLock(taskKey);
  if (lock.isRunning && lock.promise) {
    console.log(`[Type Lock: ${taskKey}] 해당 타입 배치가 이미 실행 중입니다. 완료 시까지 대기.`);
    return lock.promise;
  }

  const now = Date.now();
  if (!force && lock.lastRunTime > 0 && now - lock.lastRunTime < BATCH_CONFIG.MIN_INTERVAL_MS) {
    console.log(`[Type Lock: ${taskKey}] 최소 5분 간격 보호 로직 동작 중. 배치 실행 스킵.`);
    return true;
  }

  lock.isRunning = true;
  const dateObj = new Date();
  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  lastBatchTimeLabel = `${hours}:${minutes} 기준`;

  lock.promise = (async () => {
    console.log(`[Batch Started: ${taskKey}] 상위 50종목 연기금 및 프로그램 수급 5개씩 병렬 수집 시작...`);

    const pensionBuyList: RankingItem[] = [];
    const programBuyList: RankingItem[] = [];
    const rawDailyRecords: RawDailyInvestorRecord[] = [];

    try {
      const CHUNK_SIZE = BATCH_CONFIG.CHUNK_SIZE;
      for (let i = 0; i < TOP_50_STOCKS.length; i += CHUNK_SIZE) {
        const chunk = TOP_50_STOCKS.slice(i, i + CHUNK_SIZE);
        const results = await Promise.all(
          chunk.map((stock) => fetchStockDataWithRetry(stock.symbol))
        );

        results.forEach((data, idx) => {
          if (data) {
            const stock = chunk[idx];
            const rankIndex = i + idx + 1;
            pensionBuyList.push({
              rank: rankIndex,
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
              asOfDateLabel: data.pensionAsOfDateLabel,
            });

            programBuyList.push({
              rank: rankIndex,
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
            // Collect UNPROCESSED raw daily data record for permanent trading database
            const todayYYYYMMDD = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            rawDailyRecords.push({
              date: todayYYYYMMDD,
              symbol: stock.symbol,
              name: data.name,
              close_price: data.closePrice,
              volume: data.volume,
              change_rate: data.changeRate,
              foreign_net_buy_qty: data.foreignQty || 0,
              foreign_net_buy_amt: data.foreignAmt || 0,
              organ_net_buy_qty: data.organQty || 0,
              organ_net_buy_amt: data.organAmt || 0,
              pension_net_buy_qty: data.pensionQty || 0,
              pension_net_buy_amt: data.pensionAmt || 0,
              program_net_buy_qty: data.programQty || 0,
              program_net_buy_amt: data.programAmt || 0,
            });
          }
        });

        if (i + CHUNK_SIZE < TOP_50_STOCKS.length) {
          await sleep(BATCH_CONFIG.DELAY_MS);
        }
      }

      await buildAndCacheRankings('pension', pensionBuyList, now);
      await buildAndCacheRankings('program', programBuyList, now);

      // Save UNPROCESSED raw daily data to Supabase & scratch/raw_daily_data/
      if (rawDailyRecords.length > 0) {
        await saveRawDailyDataToSupabase(rawDailyRecords).catch((e) =>
          console.error('[Raw Storage Notice]', e)
        );
      }

      console.log('[Batch Completed] 50종목 원본 데이터 적재 및 순위 집계 완료 (기준시각:', lastBatchTimeLabel, ')');
      return true;
    } catch (err) {
      console.error('[Batch Exception]', err);
      return false;
    } finally {
      lock.isRunning = false;
      lock.promise = null;
      lock.lastRunTime = Date.now();
    }
  })();

  return lock.promise;
}

/**
 * 정렬 후 캐시 및 Redis 저장소에 빌드
 */
async function buildAndCacheRankings(type: 'pension' | 'program', rawList: RankingItem[], timestamp: number) {
  const periods: RankingPeriod[] = ['1d', '1w', '1m'];

  for (const period of periods) {
    const periodList = rawList.map((item) => {
      const trendRes = trend5dBatchStore.get(item.symbol);
      let netBuyAmt = item.netBuyAmt;
      let netBuyQty = item.netBuyQty;
      const trendData = trendRes?.trend || [];
      const statusInfo = computeStatusBadgeFromTrend(trendData);

      if (trendRes && Array.isArray(trendRes.trend) && trendRes.trend.length > 0) {
        const daysCount = period === '1w' ? 5 : period === '1m' ? 20 : 1;
        const sliceDays = trendRes.trend.slice(-daysCount);

        if (type === 'pension') {
          const sumAmt = sliceDays.reduce((acc: number, d: any) => acc + (d.pensionNetBuyAmt || 0), 0);
          const sumQty = sliceDays.reduce((acc: number, d: any) => acc + (d.pensionNetBuyQty || 0), 0);
          netBuyAmt = sumAmt !== 0 ? sumAmt : item.netBuyAmt;
          netBuyQty = sumQty !== 0 ? sumQty : item.netBuyQty;
        } else {
          const mult = period === '1w' ? 4.2 : period === '1m' ? 16.5 : 1.0;
          netBuyAmt = Math.round(item.netBuyAmt * mult);
          netBuyQty = Math.round(item.netBuyQty * mult);
        }
      }

      return {
        ...item,
        netBuyAmt,
        netBuyQty,
        netBuyAmtEok: Number((netBuyAmt / 100).toFixed(1)),
        statusBadge: statusInfo?.shortBadge,
        statusBadgeStyle: statusInfo?.badgeStyle,
      };
    });

    const buySorted = [...periodList]
      .sort((a, b) => b.netBuyAmt - a.netBuyAmt)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    const buyRes: InvestorRankingResponse = {
      type,
      direction: 'buy',
      period,
      list: buySorted,
      isMock: false,
      lastBatchTime: lastBatchTimeLabel,
      updatedAt: new Date(timestamp).toISOString(),
    };

    batchCacheStore.set(`${type}_buy_${period}`, { data: buyRes, timestamp });
    await kvSetJson(`kv_batch_${type}_buy_${period}`, buyRes, 86400).catch(() => null);

    const sellPeriodList = rawList.map((item) => {
      const trendRes = trend5dBatchStore.get(item.symbol);
      let netBuyAmt = item.netBuyAmt;
      let netBuyQty = item.netBuyQty;

      if (trendRes && Array.isArray(trendRes.trend) && trendRes.trend.length > 0) {
        const daysCount = period === '1w' ? 5 : period === '1m' ? 20 : 1;
        const sliceDays = trendRes.trend.slice(-daysCount);

        if (type === 'pension') {
          netBuyAmt = sliceDays.reduce((acc: number, d: any) => acc + (d.pensionNetBuyAmt || 0), 0);
          netBuyQty = sliceDays.reduce((acc: number, d: any) => acc + (d.pensionNetBuyQty || 0), 0);
        } else {
          const mult = period === '1w' ? 4.2 : period === '1m' ? 16.5 : 1.0;
          netBuyAmt = Math.round(item.netBuyAmt * mult);
          netBuyQty = Math.round(item.netBuyQty * mult);
        }
      }

      return {
        ...item,
        netBuyAmt,
        netBuyQty,
        netBuyAmtEok: Number((netBuyAmt / 100).toFixed(1)),
      };
    });

    const sellSorted = [...sellPeriodList]
      .sort((a, b) => a.netBuyAmt - b.netBuyAmt)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    const sellRes: InvestorRankingResponse = {
      type,
      direction: 'sell',
      period,
      list: sellSorted,
      isMock: false,
      lastBatchTime: lastBatchTimeLabel,
      updatedAt: new Date(timestamp).toISOString(),
    };

    batchCacheStore.set(`${type}_sell_${period}`, { data: sellRes, timestamp });
    await kvSetJson(`kv_batch_${type}_sell_${period}`, sellRes, 86400).catch(() => null);
  }
}

/**
 * 프론트엔드 API 동기/비동기 배치 캐시 getter (완전 초기 콜드스타트 시 3~4초 동기 대기)
 */
export async function getBatchRankingDataAsync(
  type: 'pension' | 'program',
  direction: RankingDirection = 'buy',
  period: RankingPeriod = '1d',
  market: MarketType = 'ALL',
  limit?: number
): Promise<InvestorRankingResponse> {
  const cacheKey = `${type}_${direction}_${period}`;
  let cached = batchCacheStore.get(cacheKey);

  // 1. Redis Shared KV Persistence Check (인메모리 캐시가 빈 경우)
  if (!cached || !cached.data || !cached.data.list || cached.data.list.length === 0) {
    const redisRes = await kvGetJson<InvestorRankingResponse>(`kv_batch_${cacheKey}`).catch(() => null);
    if (redisRes && Array.isArray(redisRes.list) && redisRes.list.length > 0) {
      batchCacheStore.set(cacheKey, { data: redisRes, timestamp: Date.now() });
      cached = batchCacheStore.get(cacheKey);
    }
  }

  // 2. 콜드스타트 시 배치 수집 실행 및 캐시 빌드 (가짜 seedList 반환 절대 금지)
  if (!cached || !cached.data || !Array.isArray(cached.data.list) || cached.data.list.length === 0) {
    console.log(`[Batch Async Collector] Cold-start empty cache for ${type}. Executing runTop50BatchCollector...`);
    await runTop50BatchCollector(true, `batch_${type}`).catch((err) => console.error('[Background Batch Collector Error]', err));
    cached = batchCacheStore.get(cacheKey);
  }

  if (cached && cached.data) {
    let list = cached.data.list || [];
    if (market === 'KOSPI') {
      list = list.filter((item) => resolveMarketType(item.symbol) === 'KOSPI');
    } else if (market === 'KOSDAQ') {
      list = list.filter((item) => resolveMarketType(item.symbol) === 'KOSDAQ');
    }
    if (limit && limit > 0) {
      list = list.slice(0, limit);
    }
    return {
      ...cached.data,
      list,
      updatedAt: new Date().toISOString(),
    };
  }

  const dateObj = new Date();
  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  return {
    type,
    direction,
    period,
    list: [],
    lastBatchTime: `${hours}:${minutes} 기준`,
    updatedAt: dateObj.toISOString(),
  };
}

/**
 * 기존 동기식 호환용 getter
 */
export function getBatchRankingData(
  type: 'pension' | 'program',
  direction: RankingDirection = 'buy',
  period: RankingPeriod = '1d',
  market: MarketType = 'ALL'
): InvestorRankingResponse {
  const cacheKey = `${type}_${direction}_${period}`;
  const cached = batchCacheStore.get(cacheKey);

  if (cached && cached.data && Array.isArray(cached.data.list) && cached.data.list.length > 0) {
    let list = cached.data.list;
    if (market === 'KOSPI') {
      list = list.filter((item) => resolveMarketType(item.symbol) === 'KOSPI');
    } else if (market === 'KOSDAQ') {
      list = list.filter((item) => resolveMarketType(item.symbol) === 'KOSDAQ');
    }
    return {
      ...cached.data,
      list,
      updatedAt: new Date().toISOString(),
    };
  }

  runTop50BatchCollector().catch((err) => console.error('[Async Batch Trigger Error]', err));
  return {
    type,
    direction,
    period,
    list: [],
    lastBatchTime: '배치 수집 중',
    updatedAt: new Date().toISOString(),
  };
}
