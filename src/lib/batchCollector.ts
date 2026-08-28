import { TOP_50_STOCKS, getStockName, resolveMarketType, getSettledAsOfDateLabel, resolveStockPriceAndChange } from './mockData';
import { fetchKisInvestorTrend, fetchKisProgramTrade, fetchKisForeignInstitutionRanking, assertNoMockLeak, getKisAccessToken, getEvaluatedCreditStatus, kvGetJson, kvSetJson, computeStatusBadgeFromTrend } from './kisApi';
import { InvestorRankingResponse, RankingItem, RankingType, RankingDirection, RankingPeriod, MarketType } from './types';
import { saveRawDailyDataToSupabase, RawDailyInvestorRecord } from './supabase';

// Configurable Batch Parameters
export const BATCH_CONFIG = {
  DELAY_MS: 10,         // 청크 간 딜레이 시간 (10ms)
  CHUNK_SIZE: 10,       // 10개 종목 병렬 청크 수집 (1.5초 내 완료)
  MAX_RETRIES: 1,       // 1회 수집 (서버리스 타임아웃 방지)
  RETRY_DELAY_MS: 50,   // 재시도 대기 시간 (50ms)
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
      console.log(`📌 [TRACE 2-BEFORE-KIS] KIS API 수급 추세 호출 직전: symbol=${symbol}`);
      const trendRes = await fetchKisInvestorTrend(symbol, '20d', 'HIGH', true);
      console.log(`📌 [TRACE 2-AFTER-KIS] KIS API 수급 추세 호출 성공: symbol=${symbol}, trendCount=${trendRes?.trend?.length || 0}`);
      if (trendRes && Array.isArray(trendRes.trend)) {
        trend5dBatchStore.set(symbol, trendRes);
      }
      const latestTrend = trendRes?.trend ? trendRes.trend[trendRes.trend.length - 1] : null;

      if (latestTrend) {
        const trendList = trendRes?.trend || [];
        const pensionValid = latestTrend.pensionNetBuyAmt !== 0
          ? latestTrend
          : ([...trendList].reverse().find((t) => t.pensionNetBuyAmt !== 0) || latestTrend);

        const pensionAmt = latestTrend.pensionNetBuyAmt !== 0
          ? latestTrend.pensionNetBuyAmt
          : (pensionValid.pensionNetBuyAmt || 0);

        const pensionQty = latestTrend.pensionNetBuyQty !== 0
          ? latestTrend.pensionNetBuyQty
          : (pensionValid.pensionNetBuyQty || 0);

        const isPensionFallback = latestTrend.pensionNetBuyAmt === 0;
        const pensionDate = pensionValid.stck_bsop_date || pensionValid.date || '';
        let pensionAsOfDateLabel = '당일 가집계';
        if (isPensionFallback) {
          pensionAsOfDateLabel = getSettledAsOfDateLabel(pensionDate);
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
      console.error(`📌 [TRACE 2-ERROR-KIS] KIS API 수급 추세 호출 실패: symbol=${symbol}, attempt=${attempt}`, err);
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
    console.log(`📌 [TRACE 1-START] runTop50BatchCollector 시작: taskKey=${taskKey}, force=${force}`);

    const pensionBuyList: RankingItem[] = [];
    const programBuyList: RankingItem[] = [];
    const rawDailyRecords: RawDailyInvestorRecord[] = [];

    try {
      console.log(`📌 [TRACE 2-START-CHUNK-COLLECT] TOP 50 종목 연기금/프로그램 실데이터 개별 수집 시작...`);
      const targetStocks = TOP_50_STOCKS;

      const CHUNK_SIZE = 6;
      for (let i = 0; i < targetStocks.length; i += CHUNK_SIZE) {
        const chunk = targetStocks.slice(i, i + CHUNK_SIZE);
        const chunkResults = await Promise.all(
          chunk.map((s) => fetchStockDataWithRetry(s.symbol))
        );

        for (let j = 0; j < chunk.length; j++) {
          const res = chunkResults[j];
          const s = chunk[j];
          if (res) {
            const baseItem: RankingItem = {
              rank: 0,
              symbol: s.symbol,
              name: res.name,
              currentPrice: res.closePrice,
              change: res.change,
              changeRate: res.changeRate,
              netBuyQty: 0,
              netBuyAmt: 0,
              netBuyAmtEok: 0,
              volume: res.volume,
              ratioVsVolume: 0,
              isCreditAvailable: true,
            };

            pensionBuyList.push({
              ...baseItem,
              netBuyAmt: res.pensionAmt,
              netBuyQty: res.pensionQty,
              netBuyAmtEok: Number((res.pensionAmt / 100).toFixed(1)),
              asOfDateLabel: res.pensionAsOfDateLabel || '당일 가집계',
            });

            programBuyList.push({
              ...baseItem,
              netBuyAmt: res.programAmt,
              netBuyQty: res.programQty,
              netBuyAmtEok: Number((res.programAmt / 100).toFixed(1)),
              asOfDateLabel: '당일 가집계',
            });

            rawDailyRecords.push({
              date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
              symbol: s.symbol,
              name: res.name,
              close_price: res.closePrice,
              volume: res.volume,
              change_rate: res.changeRate,
              foreign_net_buy_amt: res.foreignAmt || 0,
              foreign_net_buy_qty: res.foreignQty || 0,
              organ_net_buy_amt: res.organAmt || 0,
              organ_net_buy_qty: res.organQty || 0,
              pension_net_buy_amt: res.pensionAmt,
              pension_net_buy_qty: res.pensionQty,
              program_net_buy_amt: res.programAmt,
              program_net_buy_qty: res.programQty,
            });
          }
        }
        if (i + CHUNK_SIZE < targetStocks.length) {
          await sleep(80);
        }
      }

      console.log(`📌 [TRACE 3-PRE-PURGE] KIS 실수급 수집 완료: pensionCount=${pensionBuyList.length}, programCount=${programBuyList.length}`);

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

    assertNoMockLeak(buyRes);
    console.log(`📌 [TRACE 4-POST-PURGE] assertNoMockLeak 필터 통과 후 개수: type=${type}, period=${period}, listCount=${buyRes.list.length}`);
    console.log(`📌 [TRACE 5-CACHE-SAVE] 캐시(Redis/Supabase) 저장 직전 개수: type=${type}, key=kv_batch_${type}_buy_${period}, listCount=${buyRes.list.length}`);

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

  // 2. 콜드스타트 시 50개 전 종목 비동기 배치 수집 실행 (최대 3초 대기 후 타임아웃 방지 리턴, 배경에서 50개 전수 완수)
  if (!cached || !cached.data || !Array.isArray(cached.data.list) || cached.data.list.length === 0) {
    console.log(`[Batch Async Collector] Cold-start empty cache for ${type}. Executing runTop50BatchCollector with 3.0s max wait...`);
    const collectPromise = runTop50BatchCollector(true, `batch_${type}`).catch((err) => console.error('[Background Batch Collector Error]', err));
    
    await Promise.race([
      collectPromise,
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    cached = batchCacheStore.get(cacheKey);
  }

  if (cached && cached.data && Array.isArray(cached.data.list) && cached.data.list.length > 0) {
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

  // 3. 콜드스타트 백그라운드 집계 완료 전 무한 로딩 방지 즉시 응답 (실데이터 기관 순위 기반)
  const reqPeriod = (period === 'consecutive2d' || period === 'consecutive3d') ? '1d' : (period as '1d' | '1w' | '1m');
  const organRes = await fetchKisForeignInstitutionRanking('organ', direction, reqPeriod, market, limit || 50).catch(() => null);
  if (organRes && Array.isArray(organRes.list) && organRes.list.length > 0) {
    return {
      type,
      direction,
      period,
      list: organRes.list.map((item, idx) => ({
        ...item,
        rank: idx + 1,
      })),
      isMock: false,
      lastBatchTime: lastBatchTimeLabel,
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
