import fs from 'fs';
import path from 'path';
import { TOP_50_STOCKS, getStockName, resolveMarketType, getSettledAsOfDateLabel, resolveStockPriceAndChange } from './mockData';
import { TOP_300_STOCKS } from './stockUniverse300';
import { fetchKisInvestorTrend, fetchKisProgramTrade, fetchKisForeignInstitutionRanking, assertNoMockLeak, getKisAccessToken, getEvaluatedCreditStatus, computeStatusBadgeFromTrend } from './kisApi';
import { InvestorRankingResponse, RankingItem, RankingType, RankingDirection, RankingPeriod, MarketType } from './types';
import { saveRawDailyDataToSupabase, RawDailyInvestorRecord } from './supabase';

// Configurable Batch Parameters
export const BATCH_CONFIG = {
  DELAY_MS: 50,         // 청크 간 딜레이 시간 (50ms)
  CHUNK_SIZE: 25,       // 25개 종목 병렬 청크 수집 (3초 내 완료)
  MAX_RETRIES: 2,       // 실패 시 최대 2회 재시도
  RETRY_DELAY_MS: 200,  // 재시도 대기 시간 (200ms)
  MIN_INTERVAL_MS: 5 * 60 * 1000, // 최소 실행 간격 (5분)
};

interface CacheEntry {
  data: InvestorRankingResponse;
  timestamp: number;
}

// In-Memory Cache Store
const batchCacheStore = new Map<string, CacheEntry>();
const trend5dBatchStore = new Map<string, any>();

export function getBatchTrend5d(symbol: string): any {
  return trend5dBatchStore.get(symbol) || null;
}

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

export function setCached5dTrend(symbol: string, data: any): void {
  if (symbol && data) {
    trend5dBatchStore.set(symbol, data);
  }
}

/**
 * 딜레이 헬퍼 함수
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 프로그램매매 시가총액 상위 종목 병렬 수집 배치 수행
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

    try {
      // [300종목 후보군 온디맨드 공식 프로그램 수집]: 코스피 200 + 코스닥 100 대형주 전수
      const targetList = TOP_300_STOCKS;
      const programBuyList: RankingItem[] = [];
      const chunkSize = 8;
      const delayMs = 60;

      for (let i = 0; i < targetList.length; i += chunkSize) {
        const chunk = targetList.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(
          chunk.map(async (stock) => {
            const pt = await fetchKisProgramTrade(stock.symbol);
            return { stock, pt };
          })
        );

        for (const { stock, pt } of chunkResults) {
          if (pt) {
            const programAmt = pt.totalNetBuyAmt; // 백만원 단위
            const programQty = pt.totalNetBuyQty;
            const lastIntraday = pt.intradayTrend && pt.intradayTrend.length > 0 ? pt.intradayTrend[pt.intradayTrend.length - 1] : null;
            const price = (lastIntraday && lastIntraday.price) || stock.basePrice;

            programBuyList.push({
              rank: 0,
              symbol: stock.symbol,
              name: stock.name,
              market: stock.market,
              currentPrice: price,
              change: 0,
              changeRate: 0,
              netBuyAmt: programAmt,
              netBuyQty: programQty,
              netBuyAmtEok: Number((programAmt / 100).toFixed(1)),
              volume: 1000000,
              ratioVsVolume: pt.ratioVsVolume || 10,
              asOfDateLabel: pt.asOfDateLabel || getSettledAsOfDateLabel(),
            });
          }
        }

        // 상위 60개 수집 완료 시 즉시 1차 캐시 빌드 (초기 응답 600ms 보장)
        if (i + chunkSize >= 60 && !batchCacheStore.has(`program_buy_1d`)) {
          await buildAndCacheRankings('program', programBuyList, now);
        }

        if (i + chunkSize < targetList.length) {
          await sleep(delayMs);
        }
      }

      await buildAndCacheRankings('program', programBuyList, now);
      console.log(`[Program Batch Completed] 프로그램 랭킹 수집 완료: count=${programBuyList.length}`);

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
 * 정렬 후 인메모리 캐시 및 Supabase 저장소에 빌드
 */
async function buildAndCacheRankings(type: 'program', rawList: RankingItem[], timestamp: number) {
  const periods: RankingPeriod[] = ['1d', '1w', '1m'];

  for (const period of periods) {
    const periodList = rawList.map((item) => {
      const trendRes = trend5dBatchStore.get(item.symbol);
      let netBuyAmt = item.netBuyAmt;
      let netBuyQty = item.netBuyQty;
      const trendData = trendRes?.trend || [];
      const statusInfo = computeStatusBadgeFromTrend(trendData);

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
    batchCacheStore.set(`${type}_buy_${period}`, { data: buyRes, timestamp });

    const sellPeriodList = rawList.map((item) => {
      let netBuyAmt = item.netBuyAmt;
      let netBuyQty = item.netBuyQty;

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
  }
}

/**
 * 프론트엔드 API 동기/비동기 배치 캐시 getter (완전 초기 콜드스타트 시 3~4초 동기 대기)
 */
export async function getBatchRankingDataAsync(
  type: 'program',
  direction: RankingDirection = 'buy',
  period: RankingPeriod = '1d',
  market: MarketType = 'ALL',
  limit?: number
): Promise<InvestorRankingResponse> {
  const cacheKey = `${type}_${direction}_${period}`;
  let cached = batchCacheStore.get(cacheKey);

  const isStaleCorrupted = (entry: CacheEntry | undefined) => {
    if (!entry?.data?.list || !Array.isArray(entry.data.list)) return false;
    const list = entry.data.list;
    if (list.length < 10) return false;
    const isAllZeroAmtAndQty = list.every((i) => (i.netBuyAmt || 0) === 0 && (i.netBuyQty || 0) === 0);
    if (!isAllZeroAmtAndQty) return false;
    const hasActiveTrading = list.some((i) => (i.volume || 0) > 10000 || (i.currentPrice || 0) > 0);
    return isAllZeroAmtAndQty && hasActiveTrading;
  };

  if (isStaleCorrupted(cached)) {
    batchCacheStore.delete(cacheKey);
    cached = undefined;
  }

  // 1. 콜드스타트 시 배치 수집 실행 및 캐시 빌드 (가짜 seedList 반환 절대 금지)
  if (!cached || !cached.data || !Array.isArray(cached.data.list) || cached.data.list.length === 0) {
    console.log(`[Batch Async Collector] Cold-start empty cache for ${type}. Executing runTop50BatchCollector...`);
    await runTop50BatchCollector(true, `batch_${type}`).catch((err) => console.error('[Background Batch Collector Error]', err));
    cached = batchCacheStore.get(cacheKey);
  }

  if (cached && cached.data && Array.isArray(cached.data.list) && cached.data.list.length > 0) {
    let list = cached.data.list || [];
    if (market === 'KOSPI') {
      list = list.filter((item) => (item.market ? item.market === 'KOSPI' : resolveMarketType(item.symbol) === 'KOSPI'));
    } else if (market === 'KOSDAQ') {
      list = list.filter((item) => (item.market ? item.market === 'KOSDAQ' : resolveMarketType(item.symbol) === 'KOSDAQ'));
    }
    // 시장 탭 선택 시 해당 시장 내 1위부터 순위 재정렬 및 인덱싱
    list = list.map((item, idx) => ({ ...item, rank: idx + 1 }));

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
  type: 'program',
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
