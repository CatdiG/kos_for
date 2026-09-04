import fs from 'fs';
import path from 'path';
import { TOP_50_STOCKS, getStockName, resolveMarketType, getSettledAsOfDateLabel, resolveStockPriceAndChange } from './mockData';
import { TOP_300_STOCKS } from './stockUniverse300';
import { fetchKisInvestorTrend, fetchKisProgramTrade, fetchKisProgramTradeDaily, fetchKisForeignInstitutionRanking, assertNoMockLeak, getKisAccessToken, getEvaluatedCreditStatus, computeStatusBadgeFromTrend, resolveTrendForBadge, getGlobalMap, syncSharedRankCache, kisQueue } from './kisApi';
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
// 🚨 [추가 - 백그라운드 완성 가드] runTop50BatchCollector(returnEarly=true)가 우선순위 40종목만 동기
// 처리하고 나머지 260종목을 after()로 백그라운드 완성하는 동안, 같은 taskKey로 또 다른 요청이 들어와도
// 새 전체 스캔을 중복으로 띄우지 않기 위한 가드다 - kisApi.ts의 consecutiveOverlapBackgroundInFlight와
// 동일 패턴(수칙 1-6: 이미 검증된 기존 패턴 재사용).
const programBatchBackgroundInFlight = getGlobalMap<string, boolean>('programBatchBackgroundInFlight');

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
  warmTrend: boolean = true,
  // 🚨 [추가 - 근본 원인 수정의 UX 트레이드오프 완화] kisQueue 직렬화(위 근본 원인 수정) 후 300종목
  // 전체 스캔이 ~103~110초 걸린다(실측). 콜드스타트로 사용자가 동기 대기(await)하는 경로에서는 이게 그대로
  // 체감 지연이 되므로, returnEarly=true일 때만 우선순위 40종목(2개 chunk)만 동기 처리해 빠르게(약 12~15초)
  // 1차 캐시(isPartial:true)를 만들고 응답한다. 나머지 260종목은 Next.js after()로 백그라운드에서 이어서
  // 처리하고 완료되면 isPartial:false로 캐시를 완전판으로 덮어쓴다 - 2일/3일연속 교집합
  // (fetchConsecutiveNDaysOverlapRankingData, kisApi.ts:3442-3474)이 이미 쓰는 검증된 패턴을 그대로
  // 재사용한다(수칙 1-6). 프론트(InvestorRankingTable.tsx)는 isPartial:true인 동안 4초 간격으로 자동
  // 재조회하도록 이미 구현돼 있어 별도 프론트 수정이 필요 없다. 크론(cron/collect-program)이나 기존
  // 동기 완료를 기대하는 다른 호출부는 기본값(false)이라 동작이 전혀 바뀌지 않는다.
  returnEarly: boolean = false
): Promise<boolean> {
  const lock = getTypeLock(taskKey);
  // 🚨 [버그 수정 - 근본 원인] returnEarly일 때만 이 가드를 봤었는데, route.ts의 after() keep-warm
  // 트리거(taskKey를 'batch_program'으로 공유하도록 변경함 - 아래 참고)처럼 returnEarly=false로 같은
  // taskKey를 호출하는 다른 경로도 있다. 이 가드를 returnEarly 여부와 무관하게 항상 적용해야, 이미 진행
  // 중인 백그라운드 완성(나머지 종목)과 겹쳐 들어온 호출이 별도의 전체 재스캔을 또 띄우지 않는다 - 실측:
  // 이 가드가 returnEarly 조건부였을 때, route.ts:71의 keep-warm 트리거(당시 taskKey='after_batch_program',
  // 별개의 lock)가 이 백그라운드 완성과 동시에 kisQueue를 나눠 쓰면서 25종목 트렌드 예열조차 113.5초가
  // 걸렸다(정상 ~7.5초). 지금 있는 부분/완전 캐시를 그대로 쓰면 된다(2/3일연속의
  // consecutiveOverlapBackgroundInFlight와 동일 원칙).
  if (programBatchBackgroundInFlight.get(taskKey)) {
    console.log(`[Program Batch Background In-Flight] taskKey=${taskKey} - 백그라운드 완성 작업이 이미 진행 중이라 새 스캔을 건너뜁니다.`);
    return true;
  }

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
    console.log(`📌 [TRACE 1-START] runTop50BatchCollector 시작: taskKey=${taskKey}, force=${force}, returnEarly=${returnEarly}`);

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
      const PRIORITY_STOCK_COUNT = 40; // returnEarly=true일 때 동기로 먼저 처리할 종목 수 (2개 chunk)

      // 청크 하나(최대 20종목)를 kisQueue로 직렬 처리해 programBuyList에 누적하는 헬퍼 - 우선순위 단계와
      // 백그라운드 완성 단계가 동일 로직을 공유한다(수칙 1-6: 중복 구현 금지).
      const processChunk = async (chunk: typeof targetList) => {
        // 🚨 [버그 수정 - 근본 원인] fetchKisProgramTrade가 다른 TR(외국인/기관 랭킹 등)과 달리 kisQueue
        // (직렬화 큐, 300ms 간격 - EGW00201 방지용)를 거치지 않고 이 chunk 안에서 20종목을 완전 동시
        // (Promise.all)에 호출했다 - 실측(scratch/diagnose_program_batch_concurrency.js, 같은 20종목
        // Promise.all 패턴 재현): 1차 20/20 성공 → 2차 16/20 → 3차 4/20(80% 실패, "초당 거래건수를
        // 초과하였습니다")로 KIS 초당 거래건수 제한(TPS)에 그대로 걸렸다. 실패한 종목은
        // fetchKisProgramTrade 내부 폴백 체인(일별 API→랭킹 캐시)으로 빠지며 값이 달라지거나 콜드스타트라
        // 0이 되어, 매 실행(재시작)마다 무작위로 다른 종목이 top-50 컷오프에서 들쭉날쭉했다(사용자 실측:
        // 당일수급이 고정된 개수가 아닌 걸 여러 번 확인). 다른 TR과 동일하게 kisQueue.enqueue()로 감싸
        // 직렬화한다 - 새 rate limiter를 만들지 않고 이미 검증된 기존 큐를 재사용한다. 동시성 완화(청크 내
        // 부분 병렬)도 실측했으나 concurrency=3만 줘도 지속부하에서 11.7% 실패(scratch/diagnose_program_
        // safe_concurrency.js)라 채택하지 않았다 - 완전 직렬만 안전하다.
        const chunkResults = await Promise.all(
          chunk.map(async (stock) => {
            const pt = await kisQueue.enqueue(() => fetchKisProgramTrade(stock.symbol), 'NORMAL', `program-trade-${stock.symbol}`);
            return { stock, pt };
          })
        );

        for (const { stock, pt } of chunkResults) {
          if (pt) {
            const programAmt = pt.totalNetBuyAmt; // 백만원 단위
            const programQty = pt.totalNetBuyQty;
            const lastIntraday = pt.intradayTrend && pt.intradayTrend.length > 0 ? pt.intradayTrend[pt.intradayTrend.length - 1] : null;
            // 🚨 [버그 수정 - 수칙 1-3: 하드코딩 숏컷 금지] change/changeRate/volume을 항상 무조건 0/0/1000000으로
            // 채우고 있었다(fallback이 아니라 애초에 실데이터를 시도조차 안 하는 설계였음) - 그 결과 program
            // 타입 랭킹은 가격만 맞고 등락률·거래량은 늘 가짜였다. 이미 예열되어 있는 trend5dBatchStore
            // (getCached5dTrend, 이 파일 안에 이미 정의됨)에서 실제 최근 종가/등락률/거래량을 우선 쓰고,
            // 그마저 없을 때만(콜드스타트 등) 최후 fallback으로 넘어간다.
            const trendRes = getCached5dTrend(stock.symbol);
            const trendList = trendRes?.trend || [];
            const latest = trendList.length > 0 ? trendList[trendList.length - 1] : null;
            const price = (lastIntraday && lastIntraday.price) || latest?.closePrice || stock.basePrice;

            programBuyList.push({
              rank: 0,
              symbol: stock.symbol,
              name: stock.name,
              market: stock.market,
              currentPrice: price,
              change: latest?.priceChange || 0,
              changeRate: latest?.changeRate || 0,
              netBuyAmt: programAmt,
              netBuyQty: programQty,
              netBuyAmtEok: Number((programAmt / 100).toFixed(1)),
              volume: latest?.volume || 1000000,
              ratioVsVolume: pt.ratioVsVolume || 10,
              asOfDateLabel: pt.asOfDateLabel || getSettledAsOfDateLabel(),
            });
          }
        }
      };

      // returnEarly=false(기존 크론/기타 호출부)면 전 종목을 동기로 끝까지 처리 - 기존 동작 100% 유지.
      // returnEarly=true(사용자 콜드스타트 응답 경로)면 우선순위 40종목만 동기 처리하고 나머지는 아래에서
      // 백그라운드로 넘긴다.
      const priorityEnd = returnEarly ? Math.min(PRIORITY_STOCK_COUNT, targetList.length) : targetList.length;
      let i = 0;
      for (; i < priorityEnd; i += chunkSize) {
        const chunk = targetList.slice(i, Math.min(i + chunkSize, priorityEnd));
        await processChunk(chunk);
        if (i + chunkSize < priorityEnd) {
          await sleep(delayMs);
        }
      }

      const hasRemaining = returnEarly && i < targetList.length;
      await buildAndCacheRankings('program', programBuyList, now, hasRemaining);
      if (hasRemaining) {
        console.log(`[Program Batch Priority Completed] 우선순위 ${programBuyList.length}종목 완료(isPartial:true) - 나머지 ${targetList.length - i}종목은 백그라운드에서 이어서 처리`);
      } else {
        console.log(`[Program Batch Completed] 프로그램 랭킹 수집 완료: count=${programBuyList.length}`);
      }

      const runTrendWarmup = async () => {
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
      };

      if (hasRemaining) {
        const remainingStart = i;
        // 🚨 [Vercel 버그 수정] await 없는 IIFE로 그냥 fire-and-forget하면 Vercel 서버리스는 응답을 보내는
        // 즉시 함수 컨테이너를 죽여버려 백그라운드 완성이 중간에 잘린다 - kisApi.ts:3454-3458의
        // fetchConsecutiveNDaysOverlapRankingData와 동일하게 Next.js after()로 등록해 라우트의 maxDuration
        // 내에서 함수를 살려둔다.
        const backgroundCompletion = async () => {
          try {
            for (let j = remainingStart; j < targetList.length; j += chunkSize) {
              const chunk = targetList.slice(j, j + chunkSize);
              await processChunk(chunk);
              if (j + chunkSize < targetList.length) {
                await sleep(delayMs);
              }
            }
            await buildAndCacheRankings('program', programBuyList, now, false);
            console.log(`[Program Batch Background Completed] 전체 수집 완료: count=${programBuyList.length}`);
            await runTrendWarmup();
          } catch (e: any) {
            console.warn('[Program Batch Background Completion Failed]', e?.message || e);
          } finally {
            programBatchBackgroundInFlight.delete(taskKey);
          }
        };

        programBatchBackgroundInFlight.set(taskKey, true);
        try {
          const { after } = await import('next/server');
          after(backgroundCompletion);
        } catch (_) {
          backgroundCompletion();
        }
      } else {
        await runTrendWarmup();
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
async function buildAndCacheRankings(type: 'program', rawList: RankingItem[], timestamp: number, isPartial: boolean = false) {
  const periods: RankingPeriod[] = ['1d', '1w', '1m'];

  // 🚨 [버그 수정 - 수칙 1-6/근본 원인] 이 함수가 캐시를 "만드는" 시점에 trend5dBatchStore(라이브 예열
  // 캐시)만으로 배지를 계산해서 batchCacheStore와 Supabase(syncSharedRankCache)에 박제해왔다. 그런데
  // /api/stock/ranking?type=program 응답은 그 이후 서빙 시점에 resolveTrendForBadge(DB 1순위)로
  // 다시 보정되는데, badges API는 Supabase shared_rank_cache를 최우선으로 읽어서(getStockBadgeSummary)
  // 이 "빌드 시점 박제값"을 그대로 보여준다 - 그 결과 같은 SK스퀘어가 program 직접 조회="이평선 수렴",
  // badges API="바닥 반등"처럼 서로 다른 시점 데이터를 보여주는 게 계속 재발했다(read-time 보정만으론
  // Supabase에 저장되는 원본 자체가 안 고쳐지므로 근본 해결이 아니었음). 이제 "쓰는" 시점부터
  // resolveTrendForBadge로 통일해서 Supabase에 저장되는 원본 자체를 정확하게 만든다.
  const badgeMap = new Map<string, { shortBadge: string; badgeStyle: string }>();
  await Promise.all(
    rawList.map(async (item) => {
      const trendData = await resolveTrendForBadge(item.symbol, {
        currentPrice: item.currentPrice,
        change: item.change,
        changeRate: item.changeRate,
        volume: item.volume,
      });
      badgeMap.set(item.symbol, computeStatusBadgeFromTrend(trendData));
    })
  );

  for (const period of periods) {
    const periodList = rawList.map((item) => {
      let netBuyAmt = item.netBuyAmt;
      let netBuyQty = item.netBuyQty;
      const statusInfo = badgeMap.get(item.symbol);

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
      isPartial,
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
      isPartial,
    };

    batchCacheStore.set(`${type}_sell_${period}`, { data: sellRes, timestamp });
    syncSharedRankCache(`${type}_sell_${period}`, sellRes.list);
  }
}

/**
 * 🚨 [버그 수정] program 랭킹 캐시는 콜드스타트(warmTrend=false) 시점의 값이 그대로 영구 박제된다
 * (batchCacheStore가 재빌드되기 전까지 절대 안 바뀜 - 다음 영업일 08:30 전까지 TTL 무제한).
 * 콜드스타트 시점엔 trend5dBatchStore(getCached5dTrend)가 비어있어 change/changeRate/volume이
 * 전부 0/0/1000000 가짜 폴백으로 박제되는데, 이후 크론이나 다른 라우트 요청으로 trend5dBatchStore가
 * 채워져도 이미 캐시된 리스트는 그걸 반영할 방법이 없었다(실측: SK스퀘어 등 50개 종목 전부 더미로 확인,
 * 동시에 같은 trend5dBatchStore를 쓰는 /api/stock/badges는 정상 배지를 보여줌 - 서빙 시점에 재계산하기 때문).
 * 그래서 캐시를 서빙하는 시점마다, "더미 시그니처"(changeRate===0 && volume===1000000 - 실제 종목이
 * 우연히 이 조합일 확률은 사실상 0이라 안전한 판별 기준)인 항목만 골라 그 사이 채워졌을 수 있는
 * trend5dBatchStore 최신값으로 다시 계산한다. 트렌드가 아직도 안 채워졌으면(latest 없음) 가짜로 채우지
 * 않고 원래 값을 그대로 둔다(수칙 1-3: 가상 수식/하드코딩 금지 - 없으면 없는 대로 둔다).
 */
function enrichProgramItemFromTrendCache(item: RankingItem): RankingItem {
  const isDummySignature = item.changeRate === 0 && item.volume === 1000000;
  if (!isDummySignature) return item;

  const trendRes = trend5dBatchStore.get(item.symbol);
  const trendList = trendRes?.trend || [];
  const latest = trendList.length > 0 ? trendList[trendList.length - 1] : null;
  if (!latest) return item; // 아직 트렌드 예열 전 - 있는 그대로 반환

  const statusInfo = computeStatusBadgeFromTrend(trendList);
  return {
    ...item,
    change: latest.priceChange ?? item.change,
    changeRate: latest.changeRate ?? item.changeRate,
    volume: latest.volume ?? item.volume,
    statusBadge: statusInfo?.shortBadge ?? item.statusBadge,
    statusBadgeStyle: statusInfo?.badgeStyle ?? item.statusBadgeStyle,
  };
}

/**
 * 🚨 [버그 수정 - 수칙 1-6: foreign/organ/overlap과 동일한 resolveTrendForBadge로 통일]
 * 위 enrichProgramItemFromTrendCache는 "더미 시그니처"(콜드스타트 폴백값)만 고치는데, 값 자체(change/
 * changeRate/volume)는 멀쩡해도 statusBadge만 batchCacheStore 빌드 시점에 박제된 채 안 바뀌는 경우가
 * 있었다(실측: SK스퀘어 402340이 같은 순간 program 탭="바닥 반등", overlap/foreign 탭="이평선 수렴"로
 * 갈림 - 값은 둘 다 changeRate 6.12%로 같은데 배지만 서로 다른 시점 데이터로 계산돼 있었음). 이제
 * program 탭도 매 서빙 시점마다 foreign/organ/overlap과 동일한 resolveTrendForBadge(DB 1순위)로
 * 배지를 다시 계산해서 통일한다 - Supabase 조회 자체는 kisApi.ts의 3분 캐시로 감싸져 있어 짧은 시간
 * 안의 반복 호출은 추가 비용이 거의 없다.
 */
async function enrichProgramItemBadgeUnified(item: RankingItem): Promise<RankingItem> {
  const dummyFixed = enrichProgramItemFromTrendCache(item);

  const trendData = await resolveTrendForBadge(dummyFixed.symbol, {
    currentPrice: dummyFixed.currentPrice,
    change: dummyFixed.change,
    changeRate: dummyFixed.changeRate,
    volume: dummyFixed.volume,
  });
  if (trendData.length === 0) return dummyFixed; // DB/캐시 전부 없으면 있는 그대로(수칙 1-3)

  const statusInfo = computeStatusBadgeFromTrend(trendData);
  return {
    ...dummyFixed,
    statusBadge: statusInfo?.shortBadge ?? dummyFixed.statusBadge,
    statusBadgeStyle: statusInfo?.badgeStyle ?? dummyFixed.statusBadgeStyle,
  };
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
    // returnEarly=true: kisQueue 직렬화(근본 원인 수정) 후 300종목 전체 스캔이 ~103~110초 걸려 그대로
    // 동기 대기시키면 사용자 체감 지연이 너무 크다 - 우선순위 40종목만 기다리고 나머지는 백그라운드로
    // 넘긴다(isPartial:true 응답, 프론트가 4초 간격 자동 재조회로 완전판을 받아감).
    await runTop50BatchCollector(true, `batch_${type}`, false, true).catch((err) => console.error('[Background Batch Collector Error]', err));
    cached = batchCacheStore.get(cacheKey);
  }

  if (cached && cached.data && Array.isArray(cached.data.list) && cached.data.list.length > 0) {
    let list = cached.data.list || [];
    if (market === 'KOSPI') {
      list = list.filter((item) => (item.market ? item.market === 'KOSPI' : resolveMarketType(item.symbol) === 'KOSPI'));
    } else if (market === 'KOSDAQ') {
      list = list.filter((item) => (item.market ? item.market === 'KOSDAQ' : resolveMarketType(item.symbol) === 'KOSDAQ'));
    }
    // 서빙 시점 더미 시그니처 보정 + 배지 재계산 (콜드스타트 박제 방지 + 4경로 배지 통일 -
    // enrichProgramItemBadgeUnified 주석 참고)
    list = await Promise.all(list.map((item) => enrichProgramItemBadgeUnified(item)));
    // 시장 탭 선택 시 해당 시장 내 1위부터 순위 재정렬 및 인덱싱
    list = list.map((item, idx) => ({ ...item, rank: idx + 1 }));

    if (limit && limit > 0) {
      list = list.slice(0, limit);
    }
    // 프론트 화면에 실제로 나가는 이 리스트 안에 더미 시그니처가 하나라도 남아있으면, 아직 트렌드
    // 예열(after() 백그라운드 25종목/사이클)이 덜 끝난 상태다 - 프론트가 이 값으로 짧은 간격 재조회 여부를 판단한다.
    const stillWarming = list.some((item) => item.changeRate === 0 && item.volume === 1000000);
    return {
      ...cached.data,
      list,
      updatedAt: new Date().toISOString(),
      stillWarming,
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
    // 서빙 시점 더미 시그니처 보정 (콜드스타트 박제 방지 - enrichProgramItemFromTrendCache 주석 참고)
    list = list.map((item) => enrichProgramItemFromTrendCache(item));
    const stillWarming = list.some((item) => item.changeRate === 0 && item.volume === 1000000);
    return {
      ...cached.data,
      list,
      updatedAt: new Date().toISOString(),
      stillWarming,
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

/**
 * raw_daily_data(과거일 종가/수급 아카이브) 백필 - 여러 날짜를 한 번에 upsert한다.
 * api/cron/collect-raw-daily-data 라우트(Vercel Cron이 배포 환경에서 스케줄 호출)와, 아래
 * triggerRawDailyDataBackfillIfStale(로컬 등 Cron이 안 도는 환경에서 자동 자가치유)이 공유한다 -
 * HTTP 라우트에만 있던 로직을 여기로 옮겨서 인증(CRON_SECRET) 계층 없이도 인프로세스로 호출 가능하게 했다.
 */
export async function runRawDailyDataBackfill(
  startIdx: number = 0,
  endIdx: number = TOP_300_STOCKS.length,
  backfillDays: number = 90 // kisApi.ts의 DB_HISTORY_LOOKBACK_DAYS(90일)와 반드시 맞춘다 - 이보다 짧으면
  // 2/3일연속 계산의 trend 배열이 20일을 못 채워 ma20이 null로 빠지고 배지가 항상 "이평선 수렴"으로
  // 나온다(실측: 5일로 백필했을 때 재발 확인됨).
  // 🚨 [버그 수정] 20일로는 ma20까지만 계산 가능하고 ma60이 항상 null이 되는데, computeUnifiedStatusBadge의
  // "🔵 바닥 반등"/60일선 기준 "단기과열" 판정은 ma60(disparate60)이 필수라서 DB 기반 배지 계산 경로
  // (resolveTrendForBadge)는 절대 이 배지들을 낼 수 없었다 - 반면 차트는 라이브 API(180일치)로 정확한
  // ma60을 계산해서 "바닥 반등"이 뜨는 반면 랭킹 목록은 항상 "이평선 수렴"으로 나오는 근본 원인이었다
  // (실측: SK스퀘어 등 - 사용자가 "차트에서 계속 바닥반등 하는데 왜 랭킹은 다르냐"고 지적해서 발견).
  // 60일보다 여유있게 90일로 늘려서 ma60 계산에 필요한 최소 60개 종가를 항상 확보한다.
): Promise<{ collectedCount: number; datesBackfilled: string[]; failedCount: number; unsettledCount: number; elapsedMs: number }> {
  const targetList = TOP_300_STOCKS.slice(Math.max(0, startIdx), Math.min(TOP_300_STOCKS.length, endIdx));
  const startedAt = Date.now();
  const recordsByDate = new Map<string, RawDailyInvestorRecord[]>();
  const unsettled: string[] = [];
  const failed: string[] = [];
  let collectedCount = 0;

  const CHUNK_SIZE = 5;
  const CHUNK_DELAY_MS = 250;

  for (let i = 0; i < targetList.length; i += CHUNK_SIZE) {
    const chunk = targetList.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (stock) => {
        try {
          const trendRes = await fetchKisInvestorTrend(stock.symbol, '5d', 'LOW');
          const recentDays = (trendRes?.trend || []).slice(-backfillDays);
          if (recentDays.length === 0) {
            failed.push(stock.symbol);
            return;
          }

          const progPoints = await fetchKisProgramTradeDaily(stock.symbol).catch(() => []);
          const lastDay = recentDays[recentDays.length - 1];
          const isSettled = lastDay.foreignNetBuyAmt !== 0 || lastDay.organNetBuyAmt !== 0;
          if (!isSettled) unsettled.push(stock.symbol);

          for (const day of recentDays) {
            if (!day.date) continue;
            const progMatch = progPoints.find((p) => p.date === day.date);
            if (!recordsByDate.has(day.date)) recordsByDate.set(day.date, []);
            recordsByDate.get(day.date)!.push({
              date: day.date,
              symbol: stock.symbol,
              name: stock.name,
              close_price: day.closePrice,
              open_price: day.openPrice,
              high_price: day.highPrice,
              low_price: day.lowPrice,
              volume: day.volume,
              change_rate: day.changeRate,
              foreign_net_buy_qty: day.foreignNetBuyQty,
              foreign_net_buy_amt: day.foreignNetBuyAmt,
              organ_net_buy_qty: day.organNetBuyQty,
              organ_net_buy_amt: day.organNetBuyAmt,
              program_net_buy_qty: progMatch?.totalNetBuyQty || 0,
              program_net_buy_amt: progMatch?.totalNetBuyAmt || 0,
            });
            collectedCount++;
          }
        } catch (err: any) {
          console.warn(`[Raw Daily Data Backfill Failed] ${stock.symbol}(${stock.name}): ${err?.message || err}`);
          failed.push(stock.symbol);
        }
      })
    );
    await sleep(CHUNK_DELAY_MS);
  }

  const savedDates: string[] = [];
  for (const [date, dateRecords] of recordsByDate.entries()) {
    const ok = await saveRawDailyDataToSupabase(dateRecords);
    if (ok) savedDates.push(date);
  }
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[Raw Daily Data Backfill] 완료 - 수집 ${collectedCount}건(${recordsByDate.size}일 × 대상${targetList.length}종목), 실패 ${failed.length}건, 미확정 ${unsettled.length}건, 저장된 날짜: ${savedDates.join(',')}, 소요 ${elapsedMs}ms`
  );

  return { collectedCount, datesBackfilled: savedDates, failedCount: failed.length, unsettledCount: unsettled.length, elapsedMs };
}

// 로컬 개발 환경 자가치유용 잠금 - Vercel Cron이 없는 환경(npm run dev)에서 raw_daily_data가
// 계속 뒤처지는 걸 막기 위해, 백그라운드로(응답을 막지 않고) 한 번씩 전체 백필을 돌린다.
// 배포 환경에서도 안전하다 - 이미 Cron이 채워둔 데이터를 같은 값으로 재upsert할 뿐이라 무해하고,
// RAW_DAILY_AUTO_BACKFILL_MIN_INTERVAL_MS로 과도한 중복 실행만 막으면 된다.
const RAW_DAILY_AUTO_BACKFILL_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30분
let rawDailyBackfillState: { isRunning: boolean; lastRunTime: number } = { isRunning: false, lastRunTime: 0 };

/**
 * raw_daily_data가 최신인지 가볍게 확인하고, 뒤처져 있으면(또는 아예 확인 못 하면) 백그라운드로
 * 전체 백필을 트리거한다 - await 하지 않으므로 호출부(랭킹 API 응답 등)는 전혀 지연되지 않는다.
 * fetchConsecutiveNDaysOverlapRankingData 등 2/3일연속 계산 경로 진입 시 호출한다.
 */
export function triggerRawDailyDataBackfillIfStale(): void {
  const now = Date.now();
  if (rawDailyBackfillState.isRunning) return;
  if (now - rawDailyBackfillState.lastRunTime < RAW_DAILY_AUTO_BACKFILL_MIN_INTERVAL_MS) return;

  rawDailyBackfillState.isRunning = true;
  rawDailyBackfillState.lastRunTime = now;
  console.log('[Raw Daily Data Auto-Backfill] 백그라운드 백필 트리거 (30분 잠금 시작)');

  runRawDailyDataBackfill(0, TOP_300_STOCKS.length, 90)
    .catch((err) => console.error('[Raw Daily Data Auto-Backfill Error]', err))
    .finally(() => {
      rawDailyBackfillState.isRunning = false;
    });
}
