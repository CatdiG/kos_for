import fs from 'fs';
import path from 'path';
import { TOP_50_STOCKS, getStockName, resolveMarketType, getSettledAsOfDateLabel, resolveStockPriceAndChange } from './mockData';
import { TOP_300_STOCKS } from './stockUniverse300';
import { fetchKisInvestorTrend, fetchKisProgramTrade, fetchKisForeignInstitutionRanking, assertNoMockLeak, getKisAccessToken, getEvaluatedCreditStatus, computeStatusBadgeFromTrend, getGlobalMap, syncSharedRankCache } from './kisApi';
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
// 🚨 [버그 수정] kisApi.ts와 동일한 이유(route.ts 파일마다 별도 모듈 인스턴스가 생겨 평범한 모듈 스코프
// Map이 라우트 간 공유가 안 되던 문제)로 globalThis 기반 공유 Map(getGlobalMap)으로 전환한다.
const batchCacheStore = getGlobalMap<string, CacheEntry>('batchCacheStore');
const trend5dBatchStore = getGlobalMap<string, any>('trend5dBatchStore');

// 투자자별(외국인/기관) 트렌드 캐시 사전예열 순환 커서: 한 번의 실행(cron 1회)에 100종목을 전부
// fetchKisInvestorTrend(kisQueue 직렬 300ms) 하면 실측 92초가 걸려 maxDuration=60을 초과한다(2026-09-02 로컬 실측).
// 그래서 매 실행마다 일부(TREND_WARM_SIZE)씩만 순환 예열하여 60초 제한 안에서 안전하게 끝내고,
// 여러 번의 cron 실행에 걸쳐 전체 종목을 골고루 예열한다.
let trendWarmCursor = 0;
const TREND_WARM_SIZE = 25;

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
export async function runTop50BatchCollector(
  force: boolean = false,
  taskKey: string = 'batch_top50',
  // 트렌드 캐시 예열(295종목, kisQueue 직렬 300ms라 25종목만 예열해도 ~20~25초 소요)을 이번 실행에서도 할지 여부.
  // 사용자가 "프로그램" 탭을 열어서 콜드스타트로 이 함수가 동기 대기(await)되는 경로에서는 false로 꺼야
  // 프로그램 순매수 응답이 예열 때문에 20초 넘게 걸리는 일이 없다. 크론(cron/collect-program)이나
  // 응답을 이미 보낸 뒤 백그라운드로 도는 경로(after())에서만 true로 둬서 예열이 계속 진행되게 한다.
  warmTrend: boolean = true
): Promise<boolean> {
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
      // [TOP_300_STOCKS 전 종목 프로그램 수집]: 예전엔 코스피/코스닥 시총 상위 50씩(100종목)만 대상이라
      // 2일/3일연속 교집합 예열(트렌드 캐시)도 그만큼만 커버돼서, 히스토리(raw_daily_data 전 종목 기반)
      // 보다 훨씬 적은 종목만 후보로 잡히는 격차가 있었다(예: 샘씨엔에스 252990처럼 시총 하위권이지만
      // 실제로 2일 연속 매수 중인 종목이 아예 후보에 안 들어가서 로컬에 안 뜨던 문제). 전 종목으로 확장해서
      // 히스토리와 같은 커버리지를 맞춘다 - 트렌드 예열은 TREND_WARM_SIZE만큼 순환 커서로 도니 크기가
      // 커져도 60초 제한 문제는 없고, 전체 한 바퀴 도는 데 걸리는 시간만 늘어난다(허용 가능한 트레이드오프).
      const targetList = TOP_300_STOCKS;
      const programBuyList: RankingItem[] = [];
      const chunkSize = 20;
      const delayMs = 50;

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

        // 상위 40개 수집 완료 시 즉시 1차 캐시 빌드 (초기 응답 500ms 보장)
        if (i + chunkSize >= 40 && !batchCacheStore.has(`program_buy_1d`)) {
          await buildAndCacheRankings('program', programBuyList, now);
        }

        if (i + chunkSize < targetList.length) {
          await sleep(delayMs);
        }
      }

      await buildAndCacheRankings('program', programBuyList, now);
      console.log(`[Program Batch Completed] 프로그램 랭킹 수집 완료: count=${programBuyList.length}`);

      // 투자자별(외국인/기관) 트렌드 캐시 순환 예열: 당일교집합 상위 50위 밖 종목이라도
      // 시총 상위 100종목(코스피50+코스닥50)에 포함되면 2일/3일연속 교집합 판정에 쓸 수 있도록
      // fetchKisInvestorTrend 성공 시 자동으로 채워지는 trend5dBatchStore(getCached5dTrend)에 미리 적재한다.
      // targetList 전체(100종목)를 한 번에 예열하면 kisQueue 직렬 처리(300ms 간격 + 실제 응답지연) 때문에
      // 92초가 걸려 maxDuration=60을 초과하므로(실측), TREND_WARM_SIZE만큼만 순환 커서 방식으로 예열한다.
      if (warmTrend && targetList.length > 0) {
        const start = trendWarmCursor % targetList.length;
        let warmSlice = targetList.slice(start, start + TREND_WARM_SIZE);
        if (warmSlice.length < TREND_WARM_SIZE) {
          warmSlice = warmSlice.concat(targetList.slice(0, TREND_WARM_SIZE - warmSlice.length));
        }
        trendWarmCursor = (start + TREND_WARM_SIZE) % targetList.length;

        const warmStart = Date.now();
        await Promise.all(
          warmSlice.map((stock) =>
            fetchKisInvestorTrend(stock.symbol, '5d', 'LOW').catch((e) => {
              console.warn(`[Batch Trend Pre-warm Skip] ${stock.symbol} 트렌드 캐시 예열 실패:`, e?.message || e);
            })
          )
        );
        console.log(`[Batch Trend Pre-warm Completed] ${warmSlice.length}종목 예열 완료 (${Date.now() - warmStart}ms, 다음 커서=${trendWarmCursor})`);
      } else if (!warmTrend) {
        console.log('[Batch Trend Pre-warm Skipped] warmTrend=false로 호출됨 (사용자 응답 지연 방지 - 크론에서 별도로 예열됨)');
      }

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
    syncSharedRankCache(`${type}_buy_${period}`, buyRes.list);

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
    syncSharedRankCache(`${type}_sell_${period}`, sellRes.list);
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
    // warmTrend=false: 사용자가 지금 이 응답을 기다리고 있으므로(동기 await) 여기서는 프로그램 매매만 빠르게
    // 수집하고, 2일/3일연속용 트렌드 예열(20~25초)은 생략한다. 예열은 크론(collect-program)이 담당한다.
    await runTop50BatchCollector(true, `batch_${type}`, false).catch((err) => console.error('[Background Batch Collector Error]', err));
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
