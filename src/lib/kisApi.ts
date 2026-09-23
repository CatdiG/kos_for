// KIS API Service Module - Updated Queue Delay & Rate Limit Guard
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InvestorTrendDay, InvestorTrendResponse, KisTokenResponse, ProgramTradeIntradayPoint, ProgramTradeSummary, SupplySummary, TrendPeriod, InvestorRankingResponse, RankingItem, RankingDirection, RankingPeriod, RankingType, OverlapInvestorRank, MarketType, SurgingRankItem, ScoreBreakdown, SurgingMode, IntradayCandlePoint, IntradayPivotFibonacciLevels, IntradayChartResponse, IndexTrendResponse, IndexTrendDay, StockBadgeItem, StockBadgeSummaryResponse, VwapReclaimSignal, PivotReclaimSignal, PivotLevelSignal, PriceLegSignal } from './types';
import { getStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, registerRuntimeStockName, resolveMarketType, computeUnifiedStatusBadge, getSettledAsOfDateLabel, getKrxEstimateSlotInfo, findSplitSafeStartIndex, roundToKrxTick, computeRecentVolumeRatio } from './mockData';
import { TOP_300_STOCKS } from './stockUniverse300';
import { getMasterStockList, isEtfSymbol } from './stockDictionary';
import { fetchTokenFromSupabase, fetchCreditBatchFromSupabase, saveCreditBatchToSupabase, CreditBatchRow, fetchIntraday3mCandlesFromSupabase, fetchFreshIntraday3mCandlesFromSupabase, saveIntraday3mCandlesToSupabase, isSymbolInWsWatchlist, fetchConsecutiveOverlapWatch, upsertConsecutiveOverlapWatch, fetchDailyOverlapFirstSeen, insertDailyOverlapFirstSeenIfMissing, fetchLatestActiveBeforeDate, upsertSharedRankCache, fetchSharedRankCacheBatch, fetchWatchSignalState, upsertWatchSignalState, logReclaimSignalEvent, updateReclaimSignalOutcome } from './supabase';
// mockData.ts도 함께 써야 해서(runtimePriceCache 공유) kisApi.ts↔mockData.ts 순환 참조를 피하려고
// getGlobalMap 정의를 별도 파일(globalCache.ts)로 옮겼다 - 기존 호출부(batchCollector.ts 등)가 계속
// `from './kisApi'`로 가져다 쓸 수 있도록 여기서 재수출한다.
import { getGlobalMap } from './globalCache';
export { resolveStockPriceAndChange, computeUnifiedStatusBadge, getGlobalMap };

interface TokenCacheData {
  access_token: string;
  expires_at: number; // Timestamp in ms
  app_key_hash?: string;
}

// Global scope declaration for Next.js dev server memory persistence across HMR/reloads
declare global {
  var __kisTokenCache__: TokenCacheData | undefined;
  var __kisTokenPromise__: Promise<string | null> | undefined;
  var __lastKisOAuthError__: string | undefined;
}

const TOKEN_CACHE_KEY = Symbol.for('kis_token_cache_v2');
const LOCAL_TOKEN_FILE = path.join(process.cwd(), 'scratch', '.kis_token_cache.json');

function getGlobalTokenCache(): TokenCacheData | null {
  return (globalThis as any)[TOKEN_CACHE_KEY] || null;
}

function setGlobalTokenCache(cache: TokenCacheData): void {
  (globalThis as any)[TOKEN_CACHE_KEY] = cache;
}


/**
 * 🏷️ [shared_rank_cache 연동] getGlobalMap(위)이 "같은 컨테이너 안에서" 여러 모듈 인스턴스가
 * 캐시를 공유하게 해주는 것과 달리, 이 함수는 "서로 다른 컨테이너끼리도" 공유되도록 Supabase에
 * 마저 반영한다 - Vercel은 API 라우트마다 별도 컨테이너로 뜰 수 있어(실측 확인됨) 인메모리 캐시
 * 만으로는 다른 라우트(예: /api/stock/badges)가 이 결과를 절대 볼 수 없기 때문이다.
 *
 * 뱃지 판정에 필요한 최소 필드만 골라 저장한다(가격/거래량 등 불필요한 필드는 뺌 - 저장량과
 * 노출 표면 최소화). fire-and-forget이라 실패해도 응답에 영향 없고, await하지 않는다.
 */
export function syncSharedRankCache(cacheKey: string, list: RankingItem[] | undefined | null): void {
  if (!list || list.length === 0) return;
  const trimmed = list.map((item) => ({
    symbol: item.symbol,
    rank: item.rank,
    netBuyAmt: item.netBuyAmt,
    statusBadge: item.statusBadge,
    statusBadgeStyle: item.statusBadgeStyle,
    surgingBadge: item.surgingBadge,
    investorBadge: item.investorBadge,
    netBuyAmtEok: item.netBuyAmtEok,
    // getStockBadgeSummary의 pushIfFound가 RankingItem과 동일하게 item.scoreBreakdown?.totalScore로
    // 읽으므로, 여기서도 평평하게 펴지 않고 같은 모양(중첩 객체)으로 저장해 소스가 바뀌어도 코드가 그대로 동작하게 한다.
    scoreBreakdown: item.scoreBreakdown ? { totalScore: item.scoreBreakdown.totalScore } : undefined,
    aiPickRank: item.aiPickRank,
    ranksByType: item.ranksByType,
    // 🚨 [버그 수정 - 사용자 요청: 탭 배지 기준 시각 표시] 이 필드가 트림 목록에서 빠져 있어서
    // getStockBadgeSummary가 이 경량 캐시를 통해 조회한 배지엔 항상 asOfDateLabel이 undefined였다
    // (외국인/기관/급등주 등 대부분 이 경로를 탐) - 뱃지 판정 자체엔 안 쓰이지만 "몇 시 기준"
    // 표시에 필요한 최소 필드라 함께 싣는다.
    asOfDateLabel: item.asOfDateLabel,
  }));
  upsertSharedRankCache(cacheKey, trimmed).catch(() => {});
}

/**
 * 프로덕션/개발 응답에서 Mock/Seed 가짜 데이터 유출 방지 및 검증 가드
 * (프로덕션 환경에서도 가짜 데이터 감지 시 응답 리스트에서 즉시 제거/빈 리스트로 차단)
 */
export function assertNoMockLeak(res: InvestorRankingResponse | null | undefined): void {
  if (!res || !Array.isArray(res.list)) return;

  if (res.isMock) {
    console.error('🚨 MOCK DATA LEAKED TO PRODUCTION RESPONSE: isMock is true! Purging all items.', res.type);
    res.list = [];
    res.isMock = false;
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(`[MOCK LEAK PROTECTOR] Fake ranking data (isMock=true) attempted to bleed into response! (Type: ${res.type})`);
    }
    return;
  }

  const prePurgeCount = res.list.length;
  res.list = res.list.filter((item) => {
    if (!item) return false;
    if ((item as any).isMock === true) {
      return false;
    }
    return true;
  });

  const postPurgeCount = res.list.length;
  console.log(`[assertNoMockLeak Audit] Type: ${res.type} | Pre-Purge Count: ${prePurgeCount} | Post-Purge Count: ${postPurgeCount}`);
}

function getLocalFileTokenCache(appKeyHash: string, allowExpired: boolean = false): TokenCacheData | null {
  try {
    if (fs.existsSync(LOCAL_TOKEN_FILE)) {
      const text = fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8');
      const cache: TokenCacheData = JSON.parse(text);
      if (cache && cache.access_token && (allowExpired || cache.expires_at > Date.now()) && cache.app_key_hash === appKeyHash) {
        return cache;
      }
    }
  } catch (e) {
    console.error('[토큰 에러] getLocalFileTokenCache 디스크 조회 오류:', e);
  }
  return null;
}

function saveLocalFileTokenCache(cache: TokenCacheData): void {
  try {
    const dir = path.dirname(LOCAL_TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    console.error('[토큰 에러] saveLocalFileTokenCache 디스크 저장 오류:', e);
  }
}

export type CacheSource = 'memory' | 'file' | 'supabase' | 'none';

async function kvGetTokenCacheWithSource(appKeyHash: string, allowExpired: boolean = false): Promise<{ data: TokenCacheData | null; source: CacheSource }> {
  const now = Date.now();
  // 1. Fast in-memory check (0ms)
  const mem = getGlobalTokenCache();
  if (mem && (allowExpired || mem.expires_at > now) && (!mem.app_key_hash || mem.app_key_hash === appKeyHash)) {
    return { data: mem, source: 'memory' };
  }

  // 2. Fast local disk file check (0ms)
  const fileCache = getLocalFileTokenCache(appKeyHash, allowExpired);
  if (fileCache) {
    setGlobalTokenCache(fileCache);
    return { data: fileCache, source: 'file' };
  }

  // 3. Supabase DB Check (Read-Only)
  try {
    const supabaseToken = await fetchTokenFromSupabase();
    if (supabaseToken && supabaseToken.access_token && (allowExpired || supabaseToken.expires_at > now)) {
      const cacheData: TokenCacheData = {
        access_token: supabaseToken.access_token,
        expires_at: supabaseToken.expires_at,
        app_key_hash: appKeyHash,
      };
      setGlobalTokenCache(cacheData);
      saveLocalFileTokenCache(cacheData);
      console.log('[Supabase DB Hit] Supabase에서 중앙 KIS 토큰 조회 성공');
      return { data: cacheData, source: 'supabase' };
    }
  } catch (e: any) {
    console.error('[Supabase DB 조회 예외]', e?.message || e);
  }

  const fallback = getGlobalTokenCache() || getLocalFileTokenCache(appKeyHash, true);
  return { data: fallback, source: fallback ? 'file' : 'none' };
}

async function kvGetTokenCache(appKeyHash: string, allowExpired: boolean = false): Promise<TokenCacheData | null> {
  const res = await kvGetTokenCacheWithSource(appKeyHash, allowExpired);
  return res.data;
}

async function kvSaveTokenCache(cache: TokenCacheData): Promise<void> {
  setGlobalTokenCache(cache);
  saveLocalFileTokenCache(cache);
}

/**
 * KIS OAuth Access Token 조회 (읽기 전용 - KIS OAuth 직접 요청 100% 차단)
 * 신규 발급은 오직 Vercel Cron (/api/cron/refresh-kis-token) 라우트에서만 실행됨
 */
export async function getKisAccessTokenWithSource(): Promise<{ token: string | null; source: CacheSource }> {
  const rawKey = process.env.KIS_APPKEY || '';
  const appKey = rawKey.trim().replace(/^["']|["']$/g, '');
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const appKeyHash = `${appKey.slice(0, 6)}_${isVirtual ? 'vts' : 'real'}`;

  const { data: existingToken, source } = await kvGetTokenCacheWithSource(appKeyHash);
  if (existingToken && existingToken.access_token && existingToken.expires_at > Date.now()) {
    return { token: existingToken.access_token, source };
  }

  const { data: fallbackToken, source: fallbackSource } = await kvGetTokenCacheWithSource(appKeyHash, true);
  if (fallbackToken && fallbackToken.access_token) {
    console.warn('[KIS API Read-Only] 유효기간 만료 임박/초과된 기존 토큰 사용 (Cron 갱신 수신 전)');
    return { token: fallbackToken.access_token, source: fallbackSource };
  }

  const missingMsg = '[KIS API Read-Only Error] Supabase DB 및 캐시에 토큰이 없습니다. Cron/수동 발급이 필요합니다.';
  console.error(missingMsg);
  globalThis.__lastKisOAuthError__ = missingMsg;
  return { token: null, source: 'none' };
}

export async function getKisAccessToken(): Promise<string | null> {
  const res = await getKisAccessTokenWithSource();
  return res.token;
}

export const getKisToken = getKisAccessToken;


// =================================================================
// KIS API 전역 요청 큐(KisRequestQueue) 및 속도제어 / 백오프 재시도 / 상세 캐시
// =================================================================

export type Priority = 'HIGH' | 'NORMAL' | 'LOW';

interface QueueTask<T> {
  id: string;
  priority: Priority;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  timestamp: number;
}

class KisRequestQueue {
  private queue: QueueTask<any>[] = [];
  private isProcessing = false;
  // 🚨 [성능 개선 - 실측 근거] 200ms까지는 지속 부하(60종목 순차 조회)에서도 0% 실패를 실측으로 확인했다
  // (scratch/diagnose_program_safe_rate.js: 100ms=6.7% 실패, 150ms=1.7% 실패, 200ms=0.0%, 250ms=0.0%).
  // 300ms 대비 초당 처리량이 약 33% 늘어(3.3건→5건) 대형 배치(신용조회 300개, 프로그램매매 300개)가
  // 전체를 도는 시간이 90초→60초 수준으로 줄어든다. 다만 이 실측은 프로그램매매 TR(FHPPG04650101)
  // 하나로만 검증했다는 한계가 있다 - EGW00201이 앱키 단위(TR 무관) 전역 제한으로 보이는 정황은 있지만,
  // 다른 TR들과 섞인 실부하에서는 21대 회귀 검증으로 재확인한다.
  private minDelayMs = 200;
  private lastCallTime = 0;
  private inFlightMap = new Map<string, Promise<any>>(); // Single-Flight Map

  public enqueue<T>(fn: () => Promise<T>, priority: Priority = 'NORMAL', id?: string): Promise<T> {
    const taskId = id || `${priority}-${Date.now()}-${Math.random()}`;

    // Single-Flight 패턴: 이미 동일 id의 요청이 진행 중이면 그 Promise를 공유하여 KIS 중복 호출 방지
    if (id && this.inFlightMap.has(id)) {
      return this.inFlightMap.get(id)!;
    }

    const promise = new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        id: taskId,
        priority,
        fn,
        resolve: (val) => {
          if (id) this.inFlightMap.delete(id);
          resolve(val);
        },
        reject: (err) => {
          if (id) this.inFlightMap.delete(id);
          reject(err);
        },
        timestamp: Date.now(),
      };

      // 우선순위 정렬: HIGH(유저 종목 클릭) > NORMAL(랭킹) > LOW(신용가능 백그라운드)
      if (priority === 'HIGH') {
        const firstNonHighIndex = this.queue.findIndex((t) => t.priority !== 'HIGH');
        if (firstNonHighIndex === -1) {
          this.queue.push(task);
        } else {
          this.queue.splice(firstNonHighIndex, 0, task);
        }
      } else if (priority === 'NORMAL') {
        const firstLowIndex = this.queue.findIndex((t) => t.priority === 'LOW');
        if (firstLowIndex === -1) {
          this.queue.push(task);
        } else {
          this.queue.splice(firstLowIndex, 0, task);
        }
      } else {
        this.queue.push(task);
      }

      this.processNext();
    });

    if (id) {
      this.inFlightMap.set(id, promise);
    }

    return promise;
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const task = this.queue.shift()!;

    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minDelayMs) {
      await new Promise((r) => setTimeout(r, this.minDelayMs - elapsed));
    }
    this.lastCallTime = Date.now();

    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      this.isProcessing = false;
      this.processNext();
    }
  }
}

export const kisQueue = new KisRequestQueue();

// 전역 종목 상세 수급 캐시 (5분 유효기간)
const trendDetailCache = new Map<string, { data: InvestorTrendResponse; timestamp: number }>();
const TREND_CACHE_TTL_MS = 5 * 60 * 1000;
// fetchKisInvestorTrend가 kisQueue 없이도 동일 symbol+period 동시 중복 호출을 막기 위한 경량
// Single-Flight 맵 (kisQueue.inFlightMap과 동일한 패턴, 단 이 함수 전용으로 분리해 전역 직렬화 없이 씀).
const investorTrendInFlightMap = new Map<string, Promise<InvestorTrendResponse>>();

/**
 * rate limit(EGW00201)과 인증 오류를 분리 처리하는 백오프 재시도 헬퍼
 */
async function fetchWithRetry<T>(
  fetchFn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 600
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchFn();
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const isRateLimit = errMsg.includes('EGW00201') || errMsg.includes('EGW00202') || errMsg.includes('EGW00133') || errMsg.includes('초당') || errMsg.includes('초과');
      const isFatalAuthError = errMsg.includes('EGW00103') || errMsg.includes('AppSecret') || errMsg.includes('키가 올바르지 않습니다');

      if (isRateLimit && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
        continue;
      }

      if (isFatalAuthError) {
        throw err; // 복구 불가능한 키 오류는 즉시 발생
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, baseDelayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('최대 재시도 횟수를 초과하였습니다.');
}

let kisApiQueue: Promise<void> = Promise.resolve();
let lastKisApiCallTime = 0;

export async function enforceRateLimit(): Promise<void> {
  const nextCall = kisApiQueue.catch(() => { }).then(async () => {
    const now = Date.now();
    const elapsed = now - lastKisApiCallTime;
    if (elapsed < 300) {
      await new Promise((resolve) => setTimeout(resolve, 300 - elapsed));
    }
    lastKisApiCallTime = Date.now();
  });
  kisApiQueue = nextCall;
  return nextCall;
}

/**
 * KST(한국표준시) 기준 오늘 날짜를 YYYYMMDD 문자열로 반환한다.
 * (주의: 이 파일에는 동일한 UTC+9 변환 로직이 여러 함수에 개별적으로 흩어져 있다 - 전면 리팩토링은
 *  이번 작업 범위를 벗어나므로 손대지 않지만, 이번에 새로 추가하는 "당일 최초 진입 시각" 기능은
 *  최소한 이 공통 함수를 통해 새로운 중복을 만들지 않는다.)
 */
function getKstTodayStr(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  return `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;
}

// 🎯 [기능 추가 - 사용자 요청: "오늘 정상 속도는 별도 인프라 없이 오늘 누적 평균으로 먼저 가자"] 오늘
// KST 정규장 시작(09:00) 시각을 epoch ms로 반환한다 - cumVol(장 시작부터의 누적 거래량)을 이 시각부터
// 지금까지의 경과시간으로 나누면 새 데이터 수집 없이 "오늘 지금까지의 평균 거래 속도"를 근사할 수 있다.
// KST 09:00은 UTC 00:00과 같은 순간(같은 KST 날짜)이므로, getKstTodayStr과 동일한 관례(수칙 1-6)로
// 서버 타임존과 무관하게 KST 달력 필드만 뽑아 Date.UTC로 직접 조립한다.
function getKstMarketOpenTs(referenceTs: number): number {
  const ref = new Date(referenceTs);
  const utc = ref.getTime() + ref.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  return Date.UTC(kst.getFullYear(), kst.getMonth(), kst.getDate(), 0, 0, 0, 0);
}

// 🚨 [버그 수정 - 코드 리뷰 발견: 15:30~16:00 휴장이 "장중"으로 오판됨] 이 파일 곳곳에 있던
// `timeNum >= 900 && timeNum < 2000`(정규장 09:00~애프터마켓 20:00을 하나의 연속 구간으로 취급)은
// 정규장(09:00~15:30)과 애프터마켓(16:00~20:00) 사이의 실제 휴장 30분(15:30~16:00)을 장중으로
// 잘못 포함시킨다 - Header.tsx의 장 상태 배지는 이미 두 구간을 OR로 분리해 판정하고 있어서, 그
// 30분 동안 헤더는 "장마감"을 보여주는데 랭킹 데이터는 "장중 실시간"으로 취급하는 모순이 있었다.
// 하나의 공통 함수로 합쳐 앞으로 이 판정이 또 따로따로 어긋나지 않게 한다(수칙 1-6).
function isKrxMarketOpen(dayOfWeek: number, timeNum: number): boolean {
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isRegularSession = timeNum >= 900 && timeNum < 1530;
  const isAfterMarketSession = timeNum >= 1600 && timeNum < 2000;
  return isWeekday && (isRegularSession || isAfterMarketSession);
}

/** ISO 시각 문자열(또는 생략 시 지금)을 KST 기준 "HH:MM 최초포착" 표시 문구로 변환한다. */
function formatKstFirstSeenLabel(isoTime?: string): string {
  const d = isoTime ? new Date(isoTime) : new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 60 * 60000);
  const hh = String(kst.getHours()).padStart(2, '0');
  const mm = String(kst.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} 최초포착`;
}

export function getDynamicRankingTtl(): number {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  const hour = kstDate.getHours();
  const minute = kstDate.getMinutes();
  const timeNum = hour * 100 + minute;
  const dayOfWeek = kstDate.getDay();
  // 🚨 [버그 수정 - 사용자 지적: "그 전에는 애프터마켓이 없었어서 다 15시30분에 멈춘걸거야. 애프터
  // 마켓까지 살아있게 고치는게 맞지않을까?"] 2026-09-14 KRX 애프터마켓(16:00~20:00, 실시간 체결)
  // 도입 전에는 15:30이 하루 거래의 진짜 끝이라 이 경계가 맞았다. 지금은 20:00까지 실거래가 계속되는데
  // "장마감 후 익일 08:30까지 불변 캐시" 정책이 15:30부터 적용돼, 실측(급등주 탭)으로 확인한 것처럼
  // 애프터마켓 4시간 내내 살아있는 시세를 이 앱만 15:30 시점에 얼려서 보여주고 있었다. 정규장+애프터
  // 마켓을 하나의 "장중"으로 보고 경계를 20:00으로 옮긴다.
  const isMarketOpen = isKrxMarketOpen(dayOfWeek, timeNum);

  // 1. 장중(정규장 09:00~15:30 + 애프터마켓 16:00~20:00): 짧은 캐시로 실시간 가집계 반영
  // 🚨 [사용자 요청 반영] 원래 30초였는데, 실측(같은 종목 반복 조회) 결과 30초가 지나면 "이미 눌러본
  // 종목"이어도 캐시가 만료돼 매번 1~1.5초씩 다시 걸려서(investor-trend, 3분봉 등) 반복 클릭 체감
  // 속도가 너무 느리다는 피드백을 받았다. 가격처럼 초단위로 급변하는 값이 아니라 수급(외국인/기관
  // 누적 순매수) 데이터라 60초 정도 늦어도 분석엔 지장이 없다고 판단해 60초로 상향한다 - 이 값 하나가
  // investor-trend/프로그램매매/외국인·기관 순위/당일교집합/3분봉 5곳에 공유되므로 전부 함께 적용된다.
  if (isMarketOpen) {
    return 60 * 1000; // 60초
  }

  // 🚨 [버그 수정 - 코드 리뷰 발견] 정규장 마감(15:30)과 애프터마켓 개장(16:00) 사이 30분 휴장 구간은
  // isMarketOpen=false이면서도 아래 "다음 영업일 08:30까지" 분기 중 어느 것에도 해당하지 않아,
  // nextOpenDate가 "오늘 08:30"(이미 지난 시각)으로 남고 remainingMs가 음수가 되어 매번 30초 폴백으로
  // 떨어졌다 - 이 구간의 진짜 다음 개장은 "익일 08:30"이 아니라 "오늘 16:00 애프터마켓 재개장"이다.
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 1530 && timeNum < 1600) {
    const nextReopen = new Date(kstDate);
    nextReopen.setHours(16, 0, 0, 0);
    return Math.max(nextReopen.getTime() - kstDate.getTime(), 1000);
  }

  // 2. 장마감 후 (평일 20:00 이후 또는 주말): 다음 영업일 08:30 개장 전까지 불변 캐시
  const nextOpenDate = new Date(kstDate);
  if (dayOfWeek === 5 && timeNum >= 2000) {
    nextOpenDate.setDate(kstDate.getDate() + 3); // 금요일 밤 ➔ 월요일 08:30
  } else if (dayOfWeek === 6) {
    nextOpenDate.setDate(kstDate.getDate() + 2); // 토요일 ➔ 월요일 08:30
  } else if (dayOfWeek === 0) {
    nextOpenDate.setDate(kstDate.getDate() + 1); // 일요일 ➔ 월요일 08:30
  } else if (timeNum >= 2000) {
    nextOpenDate.setDate(kstDate.getDate() + 1); // 평일(월~목) 밤 ➔ 익일 08:30
  }

  nextOpenDate.setHours(8, 30, 0, 0);
  const remainingMs = nextOpenDate.getTime() - kstDate.getTime();
  return remainingMs > 0 ? remainingMs : 30 * 1000;
}

/**
 * Supabase 공유 랭킹 캐시(shared_rank_cache)의 `full:` 항목이 "지금 이 순간" 신선하다고 믿을 수
 * 있는 최대 나이(ms)를 계산한다. fetchSharedRankCacheBatch(keys, maxAgeMs)는 단순히
 * `now - updated_at < maxAgeMs`만 검사하므로, 여기서 maxAgeMs = "now - 가장 최근 시장 경계 시각"을
 * 돌려주면 결과적으로 "updated_at이 그 경계 이후에 기록됐는가"와 동치가 된다.
 *
 * 🚨 [버그 수정 - 수칙 1-6] 당일교집합(fetchOverlapRankingData)/N일연속 교집합
 * (fetchConsecutiveNDaysOverlapRankingData)/지수 일봉(fetchKisIndexDailyTrend) 3곳 모두, 위
 * getDynamicRankingTtl()의 "다음 영업일 08:30까지" duration을 그대로 Supabase maxAge로 재사용하고
 * 있었다. 이건 "어제 캐시가 오늘로 넘어오는 것"은 막아도, "오늘 장중 특정 시점(예: 10:02)에 기록된
 * 캐시가 그날 장마감 이후까지 그대로 최종값처럼 쓰이는 것"은 못 막는다 - duration은 "몇 시간
 * 안 지났나"만 볼 뿐 "장마감을 한 번이라도 거쳤는가"는 모르기 때문이다(실측: 삼성E&A 028050 - 3일연속
 * 탭이 오전 10:02 스냅샷 가격 49150원을 장마감 후 17시대까지 그대로 씀 - 실제로는 그 사이 5시간 반
 * 더 거래돼 종가 50800원까지 오름). 장마감 후엔 "가장 최근에 지난 마감 시각 이후에 기록됐는가"를
 * 봐야 정확하다 - 이 함수가 그 경계를 역산한다.
 *
 * 🚨 [버그 수정 - 사용자 지적: "애프터마켓까지 살아있게 고치는게 맞지않을까?"] 2026-09-14 애프터마켓
 * 도입 전엔 15:30이 진짜 마감이라 경계가 맞았지만, 지금은 20:00까지 실거래가 이어진다.
 * getDynamicRankingTtl()과 동일하게 마감 경계를 15:30 ➔ 20:00으로 옮긴다(수칙 1-6, 두 함수가 같은
 * 경계를 공유해야 한다고 위 주석에 이미 명시돼 있었다).
 */
export function getSharedCacheMaxAgeMs(): number {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  const hour = kstDate.getHours();
  const minute = kstDate.getMinutes();
  const timeNum = hour * 100 + minute;
  const dayOfWeek = kstDate.getDay();
  const isMarketOpen = isKrxMarketOpen(dayOfWeek, timeNum);

  // 1. 장중(정규장+애프터마켓): 위 getDynamicRankingTtl()과 동일하게 60초 - 경계 계산이 필요 없다.
  if (isMarketOpen) {
    return 60 * 1000;
  }

  // 🚨 [버그 수정 - 코드 리뷰 발견] getDynamicRankingTtl()에 추가한 "정규장 마감~애프터마켓 개장 사이
  // 30분 휴장" 분기가 이 함수엔 빠져 있었다 - 497번째 줄 주석에서 "두 함수가 같은 경계를 공유해야
  // 한다"고 이미 명시했는데도 이 함수만 반영이 안 돼, 이 30분 동안은 아래 일반 분기 어디에도 해당 안
  // 되어 lastCloseDate가 "오늘 20:00"(미래 시각)으로 남고 결과가 음수가 되어 항상 60초로 눌렸다.
  // 15:30~16:00은 실제 거래가 멈추는 휴장이라 15:30 이후 기록된 캐시는 16:00 재개장 전까지 그대로
  // 정확하므로, 60초로 과도하게 좁히지 않고 "15:30 이후 경과 시간"을 그대로 maxAge로 인정해도 안전하다.
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 1530 && timeNum < 1600) {
    const regularCloseDate = new Date(kstDate);
    regularCloseDate.setHours(15, 30, 0, 0);
    return Math.max(60 * 1000, kstDate.getTime() - regularCloseDate.getTime());
  }

  // 2. 장마감 후(평일 저녁/주말/개장 전 새벽): 가장 최근에 지난 20:00(애프터마켓 마감) 시각을 역산한다.
  const lastCloseDate = new Date(kstDate);
  lastCloseDate.setHours(20, 0, 0, 0);
  if (dayOfWeek === 0) {
    lastCloseDate.setDate(kstDate.getDate() - 2); // 일요일 ➔ 지난 금요일 마감
  } else if (dayOfWeek === 6) {
    lastCloseDate.setDate(kstDate.getDate() - 1); // 토요일 ➔ 어제(금요일) 마감
  } else if (timeNum < 900) {
    // 평일 개장 전(00:00~08:59) - 가장 최근 마감은 전 영업일
    lastCloseDate.setDate(kstDate.getDate() - (dayOfWeek === 1 ? 3 : 1)); // 월요일 새벽 ➔ 지난 금요일, 그 외 ➔ 어제
  }
  // else: 평일 20:00 이후 - 오늘 20:00 마감이 그대로 가장 최근 경계 (lastCloseDate 그대로 사용)

  return Math.max(60 * 1000, kstDate.getTime() - lastCloseDate.getTime());
}

/**
 * 🚨 [버그 수정 - 사용자 지적: "그 전에는 애프터마켓이 없었어서 다 15시30분에 멈춘걸거야"로 시작된
 * 조사 중 발견] 당일교집합(executeAsyncOverlapCalculation)과 2일/3일연속 교집합
 * (finalizeConsecutiveOverlapResult)이 개별 종목의 최종 asOfDateLabel을 시각과 무관하게 무조건
 * getSettledAsOfDateLabel()(정적 "(9/16 기준)" 형태)로 박아버리고 있었다 - 정작 그 안의
 * ranksByType[].asOfDateLabel은 이미 애프터마켓까지 실시간으로 잘 나오는데(외국인/기관 랭킹 자체는
 * 위 getDynamicRankingTtl() 수정으로 이미 살아있음), 이 최종 요약 라벨만 시간과 무관하게 항상
 * "정산 완료"처럼 보여서 프론트(InvestorRankingTable.tsx)가 "전 주체 종가 정산 완료"로 오판하는
 * 원인이 됐다. executeKisForeignInstitutionRankingFetch의 rankingAsOfDateLabel과 동일한 판정을
 * 단일 함수로 뽑아 재사용한다(수칙 1-6 - 이 패턴이 이제 4곳에서 필요해져서 더 이상 각자 복사하지 않음).
 */
export function getLiveOrSettledAsOfLabel(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  const hour = kstDate.getHours();
  const minute = kstDate.getMinutes();
  const timeNum = hour * 100 + minute;
  const dayOfWeek = kstDate.getDay();
  const isMarketOpen = isKrxMarketOpen(dayOfWeek, timeNum);
  if (!isMarketOpen) return getSettledAsOfDateLabel();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return `당일 가집계 (${timeStr} 기준)`;
}

// ============================================================================
// 📈 [신규 독립 모듈] KOSPI/KOSDAQ 지수 일봉 차트 (현재지수 + 일자별 시세)
// ============================================================================
const indexTrendMemoryCache = new Map<string, { data: IndexTrendResponse; timestamp: number }>();
// 🚨 [버그 수정] 고정 30초 TTL 상수는 폐기 - 아래 fetchKisIndexDailyTrend에서 다른 랭킹과 동일하게
// getDynamicRankingTtl()(장중 60초 / 장마감 후 익일 개장까지)을 쓴다.

const INDEX_CODE_MAP: Record<'KOSPI' | 'KOSDAQ', { code: '0001' | '1001'; name: string }> = {
  KOSPI: { code: '0001', name: '코스피' },
  KOSDAQ: { code: '1001', name: '코스닥' },
};

/**
 * 국내업종(KOSPI/KOSDAQ) 일봉 차트 데이터 조회. 종목과 달리 지수는 외국인/기관/프로그램
 * 순매수 개념이 KIS API에 없어(실측으로 확인됨) 일봉 OHLCV + 현재지수 요약만 제공한다.
 * - 현재지수: TR FHPUP02100000 (inquire-index-price)
 * - 일자별지수: TR FHPUP02120000 (inquire-index-daily-price, output2에 최근 100영업일치)
 */
export async function fetchKisIndexDailyTrend(
  market: 'KOSPI' | 'KOSDAQ',
  period: TrendPeriod = '60d',
  summaryOnly: boolean = false
): Promise<IndexTrendResponse> {
  const { code, name } = INDEX_CODE_MAP[market];
  // summaryOnly(카드용 현재가만)와 전체(차트용) 응답은 캐시를 분리한다 - summaryOnly 응답의 trend가
  // 비어있는데 그게 전체 조회 캐시로 잘못 재사용되면 차트가 빈 데이터를 받게 되기 때문.
  // 🚨 [기능 추가] executeKisIndexDailyTrendFetch가 이제 period와 무관하게 항상 동일한 풀 히스토리
  // (최대 199일치)를 반환하므로(위 함수 주석 참고), period별로 캐시를 나누면 같은 데이터를 3배로
  // 중복 저장/재조회하게 된다 - summaryOnly가 아닐 때는 캐시 키를 period 무관 'full'로 통일한다.
  const cacheKey = summaryOnly ? `index-${code}-summary` : `index-${code}-full`;
  // 🚨 [버그 수정 - 근본 원인] 캐시 TTL이 30초로 고정돼 있었다 - 외국인/기관/프로그램 등 다른 모든
  // 랭킹이 이미 쓰는 동적 TTL(getDynamicRankingTtl: 장중 60초 / 장마감 후 익일 개장까지)과 정책이
  // 달랐고, 그 결과 장중에도 30초마다, 장마감 후에도 30초마다 아래의 무거운 3연속 KIS 호출(현재가+
  // 일봉 2페이지, 순차 실행 시 실측 14.6초)이 반복 실행됐다 - 정책을 통일한다.
  const dynamicTtl = getDynamicRankingTtl();
  const cached = indexTrendMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < dynamicTtl) {
    return cached.data;
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  // 🚨 [버그 수정 - 근본 원인: 서버리스 인스턴스 간 캐시 불일치] 위 indexTrendMemoryCache는 프로세스
  // 로컬이라 Vercel이 새 인스턴스로 요청을 라우팅하면 매번 비어있는 채로 시작해, 다른 인스턴스가 방금
  // 끝낸 계산을 몰라보고 또 14초 넘는 3연속 호출을 반복한다(오늘 프로그램매매/당일교집합/2·3일연속
  // 교집합에서 이미 고친 것과 동일한 계열의 버그, 수칙 1-6). summaryOnly(카드용, 호출 1회로 이미 가벼움)는
  // 그대로 두고, 무거운 전체 히스토리 조회에만 공유 캐시를 추가한다. upsertSharedRankCache/
  // fetchSharedRankCacheBatch는 RankingItem[] 저장용으로 만들어졌지만 list 컬럼은 범용 JSONB라 - 새
  // 스키마 없이 응답 전체를 1개짜리 배열로 감싸 재사용한다(수칙 1-6).
  if (!summaryOnly) {
    // 🚨 [버그 수정 - 수칙 1-6] dynamicTtl(duration)을 그대로 쓰면 장중 특정 시점 스냅샷이 장마감 후까지
    // 최종값처럼 굳는 문제가 있다 - getSharedCacheMaxAgeMs()(위 함수 주석 참고)로 교체한다.
    const sharedMap = await fetchSharedRankCacheBatch([`full:${cacheKey}`], getSharedCacheMaxAgeMs()).catch(() => new Map<string, any[]>());
    const sharedWrapped = sharedMap.get(`full:${cacheKey}`);
    if (sharedWrapped && sharedWrapped.length > 0) {
      console.log(`[Shared Rank Cache Hit] full:${cacheKey} - 다른 인스턴스가 이미 계산해둔 지수 차트 데이터를 Supabase에서 재사용`);
      const shared = sharedWrapped[0] as IndexTrendResponse;
      indexTrendMemoryCache.set(cacheKey, { data: shared, timestamp: Date.now() });
      return shared;
    }
  }

  const response = await kisQueue.enqueue(
    () => fetchWithRetry(() => executeKisIndexDailyTrendFetch(code, name, period, summaryOnly)),
    'HIGH',
    cacheKey
  );

  indexTrendMemoryCache.set(cacheKey, { data: response, timestamp: Date.now() });
  if (!summaryOnly) {
    upsertSharedRankCache(`full:${cacheKey}`, [response]).catch(() => {});
  }
  return response;
}

async function executeKisIndexDailyTrendFetch(
  indexCode: '0001' | '1001',
  indexName: string,
  period: TrendPeriod,
  summaryOnly: boolean = false
): Promise<IndexTrendResponse> {
  const token = await getKisAccessToken();
  if (!token) throw new Error('[KIS 인증 토큰 발급 실패]');

  const rawKey = process.env.KIS_APPKEY || '';
  const appKey = rawKey.trim().replace(/^["']|["']$/g, '');
  const rawSecret = process.env.KIS_APPSECRET || '';
  const appSecret = rawSecret.trim().replace(/^["']|["']$/g, '');

  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const baseUrl = process.env.KIS_BASE_URL || (isVirtual ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443');

  const buildHeaders = (trId: string) => ({
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: 'P',
  });

  // 1. 지수 현재가
  // 🚨 [버그 수정 - 근본 원인] 이 함수(executeKisIndexDailyTrendFetch)도 kisQueue.enqueue(HIGH 우선순위,
  // 473번 줄)로 감싸진다 - 타임아웃 없이 hang되면 동일하게 전체 큐가 마비된다(1211번 줄 참고).
  // 🚨 [성능 수정 - 근본 원인] 원래 이 조회를 끝낸 뒤에야 아래 일봉 조회를 시작했다 - 서로 독립된
  // 데이터인데 순차로 기다릴 이유가 없다. 함수로 분리해 아래(전체 히스토리 경로)에서 일봉 1페이지와
  // Promise.all로 병렬 실행한다(실측: 순차 실행 시 차트 최초 로딩 14.6초로 "무한로딩"처럼 느껴진다는
  // 사용자 지적 - 이 병렬화 하나로 최소 1회 왕복분을 절약한다).
  const fetchPriceInfo = async (): Promise<any> => {
    const priceUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${indexCode}`;
    const priceRes = await fetch(priceUrl, { headers: buildHeaders('FHPUP02100000'), cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!priceRes.ok) throw new Error(`[KIS FHPUP02100000 HTTP ${priceRes.status}] ${indexName} 현재지수 조회 실패`);
    const priceJson = await priceRes.json();
    if (priceJson.rt_cd !== '0') throw new Error(`[KIS FHPUP02100000] ${priceJson.msg1 || '알 수 없는 오류'}`);
    return priceJson.output || {};
  };
  // 🚨 [버그 수정 - 사용자 지적: 음봉인데 +로 표시] bstp_nmix_prdy_vrss가 KIS에서 이미 부호를 포함해서
  // 내려오는데(실측: 하락 시 "-145.92", scratch/diagnose_index_sign_bug.cjs) 여기서 prdy_vrss_sign(하락)을
  // 보고 또 -1을 곱해 이중 반전시키는 바람에 실제로는 하락인데 양수로 뒤집혀 "+"로 표시되던 게 근본
  // 원인이었다. 값의 부호를 다시 추론하지 않고, 절대값으로 정규화한 뒤 KIS가 직접 내려주는
  // prdy_vrss_sign(1·2=상승, 3=보합, 4·5=하락) 하나만을 유일한 방향 판정 기준으로 삼는다 - 개별 종목
  // 시세 파싱(1672번 줄 근방 -Math.abs 패턴)과 동일한 정석 방식으로 통일(수칙 1-6). isUp도 여기서 함께
  // 확정해 프론트가 change의 부호를 다시 역산(>= 0)하지 않도록 한다.
  const parseIndexDirection = (p: any): { isUp: boolean; change: number; changeRate: number } => {
    const sign = p.prdy_vrss_sign || '3';
    const isDown = sign === '4' || sign === '5';
    const isUp = sign === '1' || sign === '2';
    const absChange = Math.abs(Number(p.bstp_nmix_prdy_vrss || 0));
    const absRate = Math.abs(Number(p.bstp_nmix_prdy_ctrt || 0));
    return {
      isUp,
      change: isDown ? -absChange : absChange,
      changeRate: isDown ? -absRate : absRate,
    };
  };

  // 2. 지수 일자별(일봉) 시세 - KIS는 최신순(내림차순)으로 내려주므로 오름차순으로 뒤집는다
  // 🚨 [성능 수정] 코스피/코스닥 카드(요약용)는 현재가만 필요하고 일봉 배열은 안 쓰는데, 예전엔 카드
  // 하나 띄울 때마다 이 무거운 일봉 호출까지 매번 같이 나가서 콜드스타트 때 kisQueue 정체를 더 키웠다.
  // summaryOnly면 이 두 번째 KIS 호출 자체를 생략한다(카드 컴포넌트가 매 페이지 로드마다 부담하던 지수당
  // 2회 → 1회로 절반 감소, KOSPI+KOSDAQ 합쳐 4회 → 2회).
  if (summaryOnly) {
    const p = await fetchPriceInfo();
    const { isUp, change, changeRate } = parseIndexDirection(p);
    return {
      indexInfo: {
        code: indexCode,
        name: indexName,
        currentPrice: Number(p.bstp_nmix_prpr || 0),
        change,
        changeRate,
        isUp,
        volume: Number(p.acml_vol || 0),
        tradingValueEok: Number((Number(p.acml_tr_pbmn || 0) / 100).toFixed(1)),
        advancingCount: Number(p.ascn_issu_cnt || 0),
        decliningCount: Number(p.down_issu_cnt || 0),
        unchangedCount: Number(p.stnr_issu_cnt || 0),
      },
      period,
      trend: [],
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
  }

  // 🚨 [기능 제거] 예전엔 120일선 계산을 위해 이 자리에서 2회 페이지네이션(최대 199영업일치)을 했었다.
  // 실측 결과 2차 페이지 조회가 종종 실패해(예: 코스닥) 100일치로 조용히 굳어버리고, 그 상태에서도
  // 프론트가 데이터 부족 체크 없이 있는 만큼만으로 "120일 이동평균"을 계산해 부정확한 수치를 그대로
  // 보여주는 문제가 있었다(수칙 1-3 위반 소지) - 120일선 기능 자체를 제거하기로 하면서(사용자 결정)
  // 이 취약한 2차 페이지 호출도 함께 제거한다. inquire-index-daily-price(FHPUP02120000) 1회 호출로
  // 받는 최근 100영업일치만으로도 화면에서 쓰는 최대 표시 구간(60일)을 충분히 커버한다.
  const dailyUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-daily-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${indexCode}&FID_INPUT_DATE_1=${getKstTodayStr()}&FID_PERIOD_DIV_CODE=D`;
  const fetchDailyPage = async (): Promise<any[]> => {
    const res = await fetch(dailyUrl, { headers: buildHeaders('FHPUP02120000'), cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`[KIS FHPUP02120000 HTTP ${res.status}] ${indexName} 일봉 조회 실패`);
    const json = await res.json();
    if (json.rt_cd !== '0') throw new Error(`[KIS FHPUP02120000] ${json.msg1 || '알 수 없는 오류'}`);
    return Array.isArray(json.output2) ? json.output2 : [];
  };

  // 지수현재가와 일봉 조회를 동시에 요청한다(위 fetchPriceInfo 분리 주석 참고) - 서로 독립된 데이터라
  // 순차로 기다릴 이유가 없다.
  const [p, combined] = await Promise.all([fetchPriceInfo(), fetchDailyPage()]); // combined: 최신순, 최대 100건
  const { isUp, change: priceChange, changeRate: priceChangeRate } = parseIndexDirection(p);

  const ascending = [...combined].reverse();

  const trend: IndexTrendDay[] = ascending.map((d) => {
    const dateStr = String(d.stck_bsop_date || '');
    return {
      date: dateStr,
      formattedDate: dateStr.length === 8 ? `${dateStr.slice(4, 6)}.${dateStr.slice(6, 8)}` : dateStr,
      openPrice: Number(d.bstp_nmix_oprc || 0),
      highPrice: Number(d.bstp_nmix_hgpr || 0),
      lowPrice: Number(d.bstp_nmix_lwpr || 0),
      closePrice: Number(d.bstp_nmix_prpr || 0),
      volume: Number(d.acml_vol || 0),
      // acml_tr_pbmn은 KIS 지수 API에서 백만원 단위로 내려온다(개별 종목 close*volume 방식과 다름 - 실측
      // 확인: /100000000으로 나누면 0억대로 뭉개져서 KOSPI 하루 거래대금이 0.2억원이 되는 오류가 있었음).
      // 억원 환산은 백만원 → 억원이므로 /100.
      tradingValueEok: Number((Number(d.acml_tr_pbmn || 0) / 100).toFixed(1)),
    };
  });

  return {
    indexInfo: {
      code: indexCode,
      name: indexName,
      currentPrice: Number(p.bstp_nmix_prpr || 0),
      change: priceChange,
      changeRate: priceChangeRate,
      isUp,
      volume: Number(p.acml_vol || 0),
      tradingValueEok: Number((Number(p.acml_tr_pbmn || 0) / 100).toFixed(1)),
      advancingCount: Number(p.ascn_issu_cnt || 0),
      decliningCount: Number(p.down_issu_cnt || 0),
      unchangedCount: Number(p.stnr_issu_cnt || 0),
    },
    period,
    trend,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * KIS 국내주식 투자자별 매매동향 API 호출 (FHKST01010900 / inquire-investor) - 전역 큐 및 캐시 적용
 */
export async function fetchKisInvestorTrend(
  symbol: string,
  period: TrendPeriod = '20d',
  priority: Priority = 'HIGH'
): Promise<InvestorTrendResponse> {
  const cacheKey = `${symbol}-${period}-v60d-full`;
  const now = Date.now();
  const dynamicTtl = getDynamicRankingTtl();

  // 1. In-Memory Cache Check with Dynamic TTL
  if (trendDetailCache.has(cacheKey)) {
    const cached = trendDetailCache.get(cacheKey)!;
    const minRequiredCount = (period === '60d') ? 120 : (period === '20d' ? 20 : 5);
    if (cached.data?.trend?.length < minRequiredCount) {
      trendDetailCache.delete(cacheKey);
    } else if (now - cached.timestamp < dynamicTtl) {
      return cached.data;
    }
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;

  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  // 🚨 [버그 수정 - 두 번째 라운드] 원래 이 함수 전체를 kisQueue.enqueue()로 감쌌다 - executeKis
  // InvestorTrendFetch 내부에서 순차로 최대 5번 KIS를 호출하는 무거운 함수라, 이 하나가 처리되는 동안
  // (특히 재시도가 겹치면 수십 초까지) 다른 모든 종목의 요청(3분봉, 다른 종목 검색 등)까지 같은 전역
  // kisQueue에서 순서를 기다리며 줄줄이 밀렸다. 실측(Vercel 프로덕션 진단 라우트)으로 KIS 자체는 동시
  // 요청에 문제없이 응답하고, 내부 fetch들도 이미 전부 8초 타임아웃이 있어(802/847/908/925번 줄)
  // "영구 hang으로 kisQueue 전체가 마비"될 위험이 없어졌으므로, 전역 직렬화를 제거하고 이 함수 자체가
  // fetchWithRetry만으로 안전하게 동작하게 한다. kisQueue의 Single-Flight(동일 symbol+period 중복
  // 호출 방지) 이점만은 별도의 가벼운 in-flight 맵으로 유지한다.
  const inFlightKey = `trend-${symbol}-${period}`;
  if (investorTrendInFlightMap.has(inFlightKey)) {
    return investorTrendInFlightMap.get(inFlightKey)!;
  }

  const fetchPromise = (async () => {
    try {
      const response = await fetchWithRetry(() => executeKisInvestorTrendFetch(symbol, period));
      if (response) {
        trendDetailCache.set(cacheKey, { data: response, timestamp: Date.now() });
      }
      return response;
    } catch (err: any) {
      if (trendDetailCache.has(cacheKey)) {
        return trendDetailCache.get(cacheKey)!.data;
      }
      throw err;
    } finally {
      investorTrendInFlightMap.delete(inFlightKey);
    }
  })();

  investorTrendInFlightMap.set(inFlightKey, fetchPromise);
  return fetchPromise;
}

/**
 * KIS OpenAPI HHPTJ04160200: 종목별 외인기관 추정가집계 조회
 * (개별 종목에 대해 10:00 1차, 11:30 2차, 13:20 3차, 14:30 4차 잠정치를 장중에 실시간 제공)
 */
// 🚨 [버그 수정 - 사용자 지적: "그런것들이 더 있나 알아봐"] 기존엔 이 함수가 kisQueue/fetchWithRetry
// 어디도 안 거치고 fetch 1회만 쏘고 실패하면(!res.ok 포함) 그냥 null로 끝났다 - 발굴 탭 "매집 주체"
// 배지(absorptionBadge)가 근거 없이 "데이터 없음"으로 빠지는 원인. AbortSignal.timeout도 없었다 - 이제
// kisQueue로 감싸므로(c2b923c에서 고친 "타임아웃 없는 큐 호출 = 큐 영구 마비" 재발 방지 위해) 반드시
// 같이 추가한다(수칙 1-6, 6곳 기존 패턴과 동일).
export async function fetchKisInvestorTrendEstimate(symbol: string): Promise<{
  foreignQty: number;
  organQty: number;
  step: string;
  timeStr: string;
} | null> {
  try {
    return await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisInvestorTrendEstimateFetch(symbol)),
      'LOW',
      `investor-trend-estimate-${symbol}`
    );
  } catch (err) {
    console.warn(`[Investor Trend Estimate Queue Error] ${symbol}:`, (err as any)?.message || err);
    return null;
  }
}

async function executeKisInvestorTrendEstimateFetch(symbol: string): Promise<{
  foreignQty: number;
  organQty: number;
  step: string;
  timeStr: string;
} | null> {
  const token = await getKisAccessToken();
  if (!token) return null;

  const rawKey = process.env.KIS_APPKEY || '';
  const appKey = rawKey.trim().replace(/^["']|["']$/g, '');
  const rawSecret = process.env.KIS_APPSECRET || '';
  const appSecret = rawSecret.trim().replace(/^["']|["']$/g, '');

  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  const qs = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J',
    MKSC_SHRN_ISCD: symbol,
  }).toString();

  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/investor-trend-estimate?${qs}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'HHPTJ04160200',
      custtype: 'P',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`[KIS HTTP Error] Status ${res.status} (investor-trend-estimate ${symbol})`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`[KIS Parse Error] investor-trend-estimate ${symbol}`);
  if (json.rt_cd !== '0') {
    throw new Error(`[KIS rt_cd Error] ${json.msg1 || json.rt_cd} (investor-trend-estimate ${symbol})`);
  }
  // rt_cd='0'(정상처리)인데 output2가 비어있는 건 "아직 그 차수 추정치가 안 나왔음"(예: 10:00 전)일
  // 뿐인 정당한 상태다 - 에러가 아니므로 재시도 대상에서 제외한다(수칙 1-3).
  if (!Array.isArray(json.output2) || json.output2.length === 0) return null;

  const latest = json.output2[0]; // 가장 최신 차수 수치
  const foreignQty = parseInt(latest.frgn_fake_ntby_qty || '0', 10);
  const organQty = parseInt(latest.orgn_fake_ntby_qty || '0', 10);

  // 단일 공통 함수(getKrxEstimateSlotInfo)를 통해 현재 KST 시각 기준 이미 경과한 차수 판정 (미래 시간 노출 원천 차단)
  const slotInfo = getKrxEstimateSlotInfo();
  return {
    foreignQty,
    organQty,
    step: slotInfo.currentSlot.step,
    timeStr: slotInfo.currentSlot.time,
  };
}

async function executeKisInvestorTrendFetch(
  symbol: string,
  period: TrendPeriod = '20d'
): Promise<InvestorTrendResponse> {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  const token = await getKisAccessToken();
  if (!token) {
    const detail = globalThis.__lastKisOAuthError__ || 'KIS 오픈API Access Token 발급 실패 (인증키 설정 및 KIS 서버 거부 상태 확인 필요)';
    throw new Error(`[KIS API 인증 오류] ${detail}`);
  }

  await enforceRateLimit();
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDateObj = new Date(today);
  startDateObj.setDate(startDateObj.getDate() - 365); // ~250 trading days (guarantees 120+ trading days for complete 60D MA calculations)
  const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  // 🚨 [버그 수정 - NXT 거래소 누락] 실측(FID_COND_MRKT_DIV_CODE=J vs NX vs UN 비교) 결과 일봉 거래량이
  // UN(통합) = J(KRX) + NX(NXT)로 정확히 일치했다 - 기존 J 고정값은 NXT 체결분(삼성전자 기준 당일 약
  // 32%)이 누락된 값이었다. 이동평균/정배열 배지 등 이 일봉 데이터를 쓰는 모든 연산에 영향을 준다.
  const dailyChartUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=UN&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

  // 🚨 [성능 개선 - 종목 검색이 3분봉보다 느린 이유] investor(수급) 조회와 daily(일봉) 1페이지 조회는
  // 서로의 결과에 전혀 의존하지 않는 완전히 독립적인 KIS 호출인데, 지금까지 순차(await 순서대로)로
  // 실행하고 있었다 - 3분봉은 14개 슬롯을 Promise.all로 동시에 쏘는데(그래서 병목이 "가장 느린 1개"),
  // 종목 검색은 이 둘을 하나씩 기다리니 병목이 "둘의 합"이었다. 진단으로 KIS 자체는 동시 요청에 문제
  // 없음을 이미 확인했으므로(kisQueue 제거 커밋 참고), 안전하게 병렬화한다 - 각각 이미 자체적으로
  // fetchWithRetry(4회 재시도)+8초 타임아웃을 갖고 있어 병렬로 묶어도 에러 처리는 그대로 독립적이다.
  const [json, dpJson] = await Promise.all([
    fetchWithRetry(async () => {
      await enforceRateLimit();
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010900',
          custtype: 'P',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });

      const text = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`[KIS API Format Error] ${text}`);
      }

      if (parsed.msg_cd === 'EGW00201' || parsed.msg_cd === 'EGW00202' || parsed.msg_cd === 'EGW00133' || parsed.msg1?.includes('초당') || parsed.msg1?.includes('초과')) {
        throw new Error(`[KIS Rate Limit] ${parsed.msg1 || 'EGW00201'}`);
      }

      if (!res.ok || parsed.rt_cd !== '0' || !Array.isArray(parsed.output)) {
        throw new Error(`[KIS API 응답 오류] ${parsed.msg1 || '응답 데이터 포맷 불일치'}`);
      }

      return parsed;
    }, 4, 800),
    (async () => {
      try {
        return await fetchWithRetry(async () => {
          await enforceRateLimit();
          const res = await fetch(dailyChartUrl, {
            method: 'GET',
            headers: {
              'content-type': 'application/json; charset=utf-8',
              authorization: `Bearer ${token}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'FHKST03010100',
              custtype: 'P',
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(8000),
          });

          const text = await res.text();
          let parsed: any;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error(`[KIS API Format Error] ${text}`);
          }

          if (parsed.msg_cd === 'EGW00201' || parsed.msg_cd === 'EGW00202' || parsed.msg_cd === 'EGW00133' || parsed.msg1?.includes('초당') || parsed.msg1?.includes('초과')) {
            throw new Error(`[KIS Rate Limit] ${parsed.msg1 || 'EGW00201'}`);
          }

          if (!res.ok || parsed.rt_cd !== '0' || !Array.isArray(parsed.output2)) {
            throw new Error(`[KIS API Chart Error] ${parsed.msg1 || '차트 데이터 오류'}`);
          }

          return parsed;
        }, 4, 800);
      } catch (e) {
        // 원래 동작과 동일: daily 조회가 끝내 실패해도 investor 조회(json)는 별개로 성공할 수 있으므로
        // 여기서만 null로 흡수하고, 아래 fullDailyItems 폴백(json.output 재사용) 경로로 넘긴다.
        return null;
      }
    })(),
  ]);

  const investorMap = new Map<string, any>();
  if (Array.isArray(json.output)) {
    json.output.forEach((item: any) => {
      const date = item.stck_bsop_date || item.bsop_date;
      if (date) investorMap.set(date, item);
    });
  }

  let fullDailyItems: any[] = [];
  if (dpJson && dpJson.rt_cd === '0' && Array.isArray(dpJson.output2) && dpJson.output2.length > 0) {
    const page1Ascending = dpJson.output2.slice().reverse(); // Ascending date
    fullDailyItems = page1Ascending;
    // Robust Pagination: Only fetch preceding trading days for 60d/1y periods (page 1 already has 30 days for 5d/20d)
    const getObjDate = (item: any) => item?.stck_bsop_date || item?.bsop_date || item?.date || '';
    let currentEnd = getObjDate(page1Ascending[0]);
    const targetMinDays = (period === '5d' || period === '20d') ? 20 : 120;

    for (let p = 2; p <= 4 && fullDailyItems.length < targetMinDays; p++) {
      if (!currentEnd || currentEnd.length !== 8) break;
      const py = parseInt(currentEnd.slice(0, 4), 10);
      const pm = parseInt(currentEnd.slice(4, 6), 10) - 1;
      const pd = parseInt(currentEnd.slice(6, 8), 10);
      const pEndObj = new Date(py, pm, pd);
      pEndObj.setDate(pEndObj.getDate() - 1);
      const pEndDate = pEndObj.toISOString().slice(0, 10).replace(/-/g, '');

      const pStartObj = new Date(pEndObj);
      pStartObj.setDate(pStartObj.getDate() - 120);
      const pStartDate = pStartObj.toISOString().slice(0, 10).replace(/-/g, '');

      // 🚨 [버그 수정 - NXT 거래소 누락] 위 dailyChartUrl과 동일 TR, 동일 실측 근거로 UN 적용.
      const pUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=UN&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${pStartDate}&FID_INPUT_DATE_2=${pEndDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

      // 🚨 [버그 수정 - 근본 원인] 3분봉(fetchKis3mCandlesFullDay)에서 발견한 것과 동일한 패턴 - 이
      // 페이지네이션 루프의 fetch 2곳(원본 요청 + 레이트리밋 재시도)엔 타임아웃이 전혀 없었다. 이
      // executeKisInvestorTrendFetch 함수 전체가 kisQueue.enqueue()로 감싸져 있어서(683번 줄), 여기서
      // KIS 응답이 지연되면 함수가 안 끝나고 kisQueue 전체를 점유해 다른 모든 요청(다른 종목 검색,
      // 랭킹 조회 등)까지 줄줄이 밀린다(실측: symbol=009540&period=60d가 40초+ 응답 없음, curl status=000).
      // 이 함수 안의 다른 두 fetch(802/847번 줄)와 동일하게 8초 타임아웃을 추가한다.
      await new Promise((r) => setTimeout(r, 250));
      let pRes = await fetch(pUrl, {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST03010100',
          custtype: 'P',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);

      if (pRes && pRes.ok) {
        let pJson = await pRes.json().catch(() => null);
        if (pJson && pJson.rt_cd !== '0' && (pJson.msg1?.includes('초당') || pJson.msg_cd === 'EGW00201')) {
          await new Promise((r) => setTimeout(r, 500));
          const retryRes = await fetch(pUrl, {
            method: 'GET',
            headers: {
              'content-type': 'application/json; charset=utf-8',
              authorization: `Bearer ${token}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'FHKST03010100',
              custtype: 'P',
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(8000),
          }).catch(() => null);
          if (retryRes && retryRes.ok) pJson = await retryRes.json().catch(() => null);
        }

        if (pJson && pJson.rt_cd === '0' && Array.isArray(pJson.output2) && pJson.output2.length > 0) {
          const pAscending = pJson.output2.slice().reverse();
          fullDailyItems = [...pAscending, ...fullDailyItems];
          currentEnd = getObjDate(pAscending[0]);
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  if (fullDailyItems.length === 0) {
    if (Array.isArray(json.output) && json.output.length > 0) {
      fullDailyItems = json.output.slice().reverse();
    }
  }

  if (fullDailyItems.length === 0) {
    throw new Error(`[KIS API 오류] 종목(${symbol})의 일별 시세 데이터를 가져올 수 없습니다.`);
  }

  // 1. Raw Data Verification Logging

  let cumForeign = 0;
  let cumOrgan = 0;

  const masterPriceInfo = resolveStockPriceAndChange(symbol, 0, 0, 0);

  const trend: InvestorTrendDay[] = fullDailyItems.map((item: any) => {
    const dateStr = item.stck_bsop_date || item.bsop_date || '';
    const invItem = investorMap.get(dateStr) || {};

    let openPrice = parseInt(item.stck_oprc || '0', 10);
    let highPrice = parseInt(item.stck_hgpr || '0', 10);
    let lowPrice = parseInt(item.stck_lwpr || '0', 10);
    const closePrice = parseInt(item.stck_clpr || item.stck_prpr || '0', 10);

    const sign = item.prdy_vrss_sign || '3';
    let priceChange = parseInt(item.prdy_vrss || '0', 10);
    if (sign === '4' || sign === '5') {
      priceChange = -Math.abs(priceChange);
    }
    const prevPrice = closePrice - priceChange;
    const changeRate = prevPrice > 0 ? parseFloat(((priceChange / prevPrice) * 100).toFixed(2)) : 0;
    const volume = parseInt(item.acml_vol || '0', 10);

    // If OHLC openPrice or high/low is 0/unpopulated (e.g. investor API fallback), derive logical open/high/low
    if ((openPrice === 0 || highPrice === 0 || lowPrice === 0) && closePrice > 0) {
      const baseOpen = prevPrice > 0 ? prevPrice : closePrice - priceChange;
      openPrice = openPrice > 0 ? openPrice : baseOpen;

      const bodyMax = Math.max(openPrice, closePrice);
      const bodyMin = Math.min(openPrice, closePrice);

      highPrice = highPrice > 0 ? Math.max(highPrice, bodyMax) : bodyMax;
      lowPrice = lowPrice > 0 ? Math.min(lowPrice, bodyMin) : bodyMin;
    }

    let foreignQty = 0;
    let foreignAmt = 0;
    let organQty = 0;
    let organAmt = 0;

    if (invItem) {
      foreignQty = parseInt(invItem.frgn_ntby_qty || invItem.frgn_ntby_vol || '0', 10);
      foreignAmt = parseInt(invItem.frgn_ntby_tr_pbmn || invItem.frgn_ntby_amt || '0', 10);

      organQty = parseInt(invItem.orgn_ntby_qty || invItem.orgn_ntby_vol || '0', 10);
      organAmt = parseInt(invItem.orgn_ntby_tr_pbmn || invItem.orgn_ntby_amt || '0', 10);
    }

    cumForeign += foreignAmt;
    cumOrgan += organAmt;

    const formattedDate = dateStr.length === 8 ? `${dateStr.slice(4, 6)}.${dateStr.slice(6, 8)}` : dateStr;

    return {
      date: dateStr,
      formattedDate,
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      priceChange,
      changeRate,
      volume,
      foreignNetBuyQty: foreignQty,
      foreignNetBuyAmt: foreignAmt,
      organNetBuyQty: organQty,
      organNetBuyAmt: organAmt,
      cumForeignNetBuyAmt: cumForeign,
      cumOrganNetBuyAmt: cumOrgan,
    };
  });

  const latest = trend[trend.length - 1] || { closePrice: masterPriceInfo.currentPrice, priceChange: masterPriceInfo.change, changeRate: masterPriceInfo.changeRate };

  const latestValidDay = [...trend].reverse().find(
    (t) => t.foreignNetBuyAmt !== 0 || t.organNetBuyAmt !== 0
  ) || latest;

  const priceInfo = resolveStockPriceAndChange(
    symbol,
    latest.closePrice || masterPriceInfo.currentPrice,
    latest.priceChange,
    latest.changeRate
  );

  // 🚨 [버그 수정] getStockName(symbol) 정적 4단계 조회(런타임 캐시/PRESET/TOP300/마스터캐시)가 전부
  // 실패하면 심볼 숫자를 이름 자리에 그대로 반환한다 - 검색창 헤더 등 이 stockInfo.name을 그대로 쓰는
  // 화면에 "386380 386380"처럼 코드만 두 번 뜨는 근본 원인이었다(실측: 스카이랩스 386380, 니어스랩
  // 417030 등 최근 상장/우선주 종목에서 재현). 정적 조회가 실패한 경우에만(대부분은 안 그럼 - 추가
  // 비용 없음) 이미 있는 신용조회 API(fetchKisCreditAvailable, hts_kor_isnm 포함)를 한 번 더 호출해
  // 실제 KIS 종목명을 받아온다. 그마저 실패하면(네트워크 오류 등) 가짜로 채우지 않고 심볼 그대로 둔다(수칙 1-3).
  let resolvedName = getStockName(symbol);
  if (resolvedName === symbol) {
    await fetchKisCreditAvailable(symbol).catch(() => undefined);
    resolvedName = getStockName(symbol); // fetchKisCreditAvailable 성공 시 내부에서 registerRuntimeStockName 등록됨
  }

  // 🚨 [기능 추가] investor-trend 응답의 stockInfo에는 신용가능 여부가 아예 없었다(실측 확인: 이 함수
  // 어디에도 isCreditAvailable을 채우는 코드가 없었음) - 모바일 종목 상세 화면에 신용정보 배지를 추가하며
  // 발견했다. 랭킹 파이프라인이 이미 쓰는 동일 함수(getEvaluatedCreditStatus, 배치/개별 신용조회 캐시
  // 기반, 추가 KIS 호출 없음)를 그대로 재사용한다(수칙 1-6) - 새 판정 로직을 만들지 않는다.
  const stockInfo = {
    symbol,
    name: resolvedName,
    market: resolveMarketType(symbol),
    currentPrice: priceInfo.currentPrice,
    change: priceInfo.change,
    changeRate: priceInfo.changeRate,
    volume: latest.volume || 1000000,
    isCreditAvailable: getEvaluatedCreditStatus(symbol, resolvedName),
  };

  const net5dForeign = trend.slice(-5).reduce((s, i) => s + i.foreignNetBuyAmt, 0);
  const net20dForeign = trend.slice(-20).reduce((s, i) => s + i.foreignNetBuyAmt, 0);

  const net5dOrgan = trend.slice(-5).reduce((s, i) => s + i.organNetBuyAmt, 0);
  const net20dOrgan = trend.slice(-20).reduce((s, i) => s + i.organNetBuyAmt, 0);

  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  const hour = kstDate.getHours();
  const minute = kstDate.getMinutes();
  const timeNum = hour * 100 + minute;
  const dayOfWeek = kstDate.getDay();
  // 🚨 [버그 수정 - 애프터마켓 도입] getDynamicRankingTtl()과 동일한 이유로 15:30 ➔ 20:00 - 라벨을
  // "당일 실시간"으로 보여줄지 결정하는 경계다. isWeekdayPostMarket(가집계 추정치 폴백 시도 여부)은
  // 원래도 상한이 없어(>=1530) 애프터마켓 시간대를 이미 포함하고 있었으므로 그대로 둔다.
  const isMarketOpen = isKrxMarketOpen(dayOfWeek, timeNum);
  const isWeekdayPostMarket = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 1530;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // KIS OpenAPI HHPTJ04160200: 종목별 외인기관 추정가집계 조회
  let realtimeForeignAmt: number | null = null;
  let realtimeForeignQty: number | null = null;
  let realtimeOrganAmt: number | null = null;
  let realtimeOrganQty: number | null = null;
  let estimateDateLabel: string | null = null;

  // 당일 확정치 입고 여부 (latest에 당일 수급이 들어왔는지 확인)
  const isTodaySettled = latest.foreignNetBuyAmt !== 0 || latest.organNetBuyAmt !== 0;

  // 장중이거나 장마감 후 당일 확정치 입고 전(18:00 전)에는 당일 가집계(14:30 최종)를 최우선 조회하여 보존
  if ((isMarketOpen || isWeekdayPostMarket) && !isTodaySettled) {
    const estimateRes = await fetchKisInvestorTrendEstimate(symbol).catch(() => null);
    if (estimateRes && (estimateRes.foreignQty !== 0 || estimateRes.organQty !== 0)) {
      realtimeForeignQty = estimateRes.foreignQty;
      realtimeOrganQty = estimateRes.organQty;
      const basePrice = stockInfo.currentPrice > 0 ? stockInfo.currentPrice : (latestValidDay.closePrice || 100000);
      realtimeForeignAmt = Math.round((estimateRes.foreignQty * basePrice) / 1000000);
      realtimeOrganAmt = Math.round((estimateRes.organQty * basePrice) / 1000000);
      const krxSlot = getKrxEstimateSlotInfo();
      estimateDateLabel = krxSlot.formattedEstimateLabel;
    }
  }

  // 랭킹 캐시에서 추가 보정 (랭킹 캐시가 있으면 랭킹의 정확한 대금 사용)
  for (const [key, cached] of rankingCacheStore.entries()) {
    if (cached && Array.isArray(cached.list)) {
      const match = cached.list.find((it) => it.symbol === symbol);
      if (match) {
        if (cached.type === 'foreign' && match.netBuyAmt !== undefined) {
          realtimeForeignAmt = match.netBuyAmt;
          realtimeForeignQty = match.netBuyQty ?? realtimeForeignQty;
        } else if (cached.type === 'organ' && match.netBuyAmt !== undefined) {
          realtimeOrganAmt = match.netBuyAmt;
          realtimeOrganQty = match.netBuyQty ?? realtimeOrganQty;
        }
      }
    }
  }

  const formatBsopDateLabel = (dateStr?: string, isFallback?: boolean, isRealtimeData?: boolean) => {
    if (estimateDateLabel && isRealtimeData) {
      return estimateDateLabel;
    }
    const krxSlot = getKrxEstimateSlotInfo();
    if (isMarketOpen) {
      if (isRealtimeData || !isFallback) {
        return krxSlot.formattedEstimateLabel;
      }
    }
    if (dateStr) {
      const cleaned = dateStr.replace(/-/g, '');
      if (cleaned.length === 8) {
        const month = parseInt(cleaned.substring(4, 6), 10);
        const day = parseInt(cleaned.substring(6, 8), 10);
        return isMarketOpen ? `(${month}/${day} 마감 기준)` : `(${month}/${day} 기준)`;
      }
      return `(${dateStr} 기준)`;
    }
    return getSettledAsOfDateLabel();
  };

  const finalForeignAmt = realtimeForeignAmt !== null
    ? realtimeForeignAmt
    : (latest.foreignNetBuyAmt !== 0 ? latest.foreignNetBuyAmt : (latestValidDay.foreignNetBuyAmt || 0));

  const finalForeignQty = realtimeForeignQty !== null
    ? realtimeForeignQty
    : (latest.foreignNetBuyQty !== 0 ? latest.foreignNetBuyQty : (latestValidDay.foreignNetBuyQty || 0));

  const finalOrganAmt = realtimeOrganAmt !== null
    ? realtimeOrganAmt
    : (latest.organNetBuyAmt !== 0 ? latest.organNetBuyAmt : (latestValidDay.organNetBuyAmt || 0));

  const finalOrganQty = realtimeOrganQty !== null
    ? realtimeOrganQty
    : (latest.organNetBuyQty !== 0 ? latest.organNetBuyQty : (latestValidDay.organNetBuyQty || 0));

  const isForeignFallback = realtimeForeignAmt === null && latest.foreignNetBuyAmt === 0 && (latestValidDay.foreignNetBuyAmt || 0) !== 0;
  const isOrganFallback = realtimeOrganAmt === null && latest.organNetBuyAmt === 0 && (latestValidDay.organNetBuyAmt || 0) !== 0;

  const validDate = latestValidDay.stck_bsop_date || latestValidDay.date;

  const summary: SupplySummary = {
    foreign: {
      todayEstimateAmt: finalForeignAmt,
      todayEstimateQty: finalForeignQty,
      net5d: net5dForeign,
      net20d: net20dForeign,
      net60d: cumForeign,
      status: net20dForeign > 500 ? 'STRONG_BUY' : net20dForeign < -500 ? 'STRONG_SELL' : 'NEUTRAL',
      isFallback: isForeignFallback,
      asOfDateLabel: formatBsopDateLabel(validDate, isForeignFallback, realtimeForeignAmt !== null),
    },
    organ: {
      todayEstimateAmt: finalOrganAmt,
      todayEstimateQty: finalOrganQty,
      net5d: net5dOrgan,
      net20d: net20dOrgan,
      net60d: cumOrgan,
      status: net20dOrgan > 500 ? 'STRONG_BUY' : net20dOrgan < -500 ? 'STRONG_SELL' : 'NEUTRAL',
      isFallback: isOrganFallback,
      asOfDateLabel: formatBsopDateLabel(validDate, isOrganFallback, realtimeOrganAmt !== null),
    },
  };

  const programTrade = await fetchKisProgramTrade(symbol, token, baseUrl, appKey, appSecret, stockInfo.currentPrice).catch(() => null);

  // 과거 일봉 트렌드에 실제 KIS 프로그램 일별 TR 데이터(fetchKisProgramTradeDaily) 100% 실데이터 매핑
  const dailyProgPoints = await fetchKisProgramTradeDaily(symbol, token, baseUrl, appKey, appSecret).catch(() => []);
  if (dailyProgPoints && dailyProgPoints.length > 0) {
    trend.forEach((d) => {
      const dt = d.stck_bsop_date || d.date || '';
      const matched = dailyProgPoints.find((p) => p.date === dt);
      if (matched) {
        (d as any).programNetBuyAmt = matched.totalNetBuyAmt;
      }
    });
  }

  // 오늘 장중인 경우, trend 배열의 마지막 날짜에 실시간 외인/기관/프로그램 수급 주입 (일봉 수급 막대 차트 및 연속일수 실시간 동기화)
  if (trend.length > 0 && (isMarketOpen || isWeekdayPostMarket)) {
    const lastTrendDay = trend[trend.length - 1];
    const todayDateStr = `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;
    const lastDate = lastTrendDay.stck_bsop_date || lastTrendDay.date || '';
    if (lastDate === todayDateStr || lastDate === '') {
      if (finalForeignAmt !== null && finalForeignAmt !== undefined) {
        lastTrendDay.foreignNetBuyAmt = finalForeignAmt;
      }
      if (finalOrganAmt !== null && finalOrganAmt !== undefined) {
        lastTrendDay.organNetBuyAmt = finalOrganAmt;
      }
      if (programTrade && programTrade.totalNetBuyAmt !== undefined) {
        (lastTrendDay as any).programNetBuyAmt = programTrade.totalNetBuyAmt;
      }
    }
  }

  const res: InvestorTrendResponse = {
    stockInfo,
    period,
    trend,
    summary,
    programTrade: programTrade || undefined,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };

  try {
    const { setCached5dTrend } = require('./batchCollector');
    setCached5dTrend(symbol, res);
  } catch { }

  return res;
}

export async function fetchKisProgramTrade(
  symbol: string,
  token?: string,
  baseUrl?: string,
  appKey?: string,
  appSecret?: string,
  currentPrice: number = 70000
): Promise<ProgramTradeSummary> {
  try {
    const tk = token || (await getKisAccessToken());
    if (!tk) {
      return {
        status: 'NEUTRAL',
        totalNetBuyQty: 0,
        totalNetBuyAmt: 0,
        ratioVsVolume: 0,
        asOfDateLabel: '당일 가집계',
        intradayTrend: [],
      };
    }
    const isVirtual = process.env.KIS_VIRTUAL === 'true';
    const defaultBaseUrl = isVirtual
      ? 'https://openapivts.koreainvestment.com:29443'
      : 'https://openapi.koreainvestment.com:9443';
    const urlBase = baseUrl || process.env.KIS_BASE_URL || defaultBaseUrl;
    const key = appKey || process.env.KIS_APPKEY || '';
    const sec = appSecret || process.env.KIS_APPSECRET || '';

    // 🚨 [버그 수정 - NXT 거래소 누락] 실측 결과 acml_vol이 J=7,406,229 / NX=3,627,278 / UN=11,039,079
    // (UN≈J+NX)로 뚜렷이 달랐다 - 프로그램매매 순매수 수량·금액이 NXT 체결분만큼 실제로 누락되고
    // 있었다(약 33%). UN(통합)으로 전환한다.
    const url = `${urlBase}/uapi/domestic-stock/v1/quotations/program-trade-by-stock?FID_COND_MRKT_DIV_CODE=UN&FID_INPUT_ISCD=${symbol}`;
    // 🚨 [버그 수정 - 근본 원인] 이 fetch에 타임아웃이 없었다 - kisQueue.enqueue()로 감싸 완전 직렬화한
    // 뒤(위 근본 원인 수정), KIS 서버가 응답을 지연시키는 단 1건만 있어도 그 fetch가 영원히 pending되면서
    // KisRequestQueue.processNext()의 isProcessing이 영구히 true로 남아 이후 모든 KIS 호출(외국인/기관
    // 랭킹 등 이 앱 전체가 공유하는 큐)까지 통째로 멈춰버렸다(실측: returnEarly 백그라운드 완성이 355초가
    // 넘도록 끝나지 않고 hang - kisQueue 직렬화 이전엔 병렬 호출이라 종목 1개가 hang돼도 나머지 219개엔
    // 영향이 없어서 드러나지 않던 문제). 다른 fetch 호출들(1750/1820/3773번 줄)과 동일하게
    // AbortSignal.timeout(8000)을 추가해 8초 이상 응답이 없으면 자동 취소되고 폴백 체인으로 넘어가게 한다.
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${tk}`,
        appkey: key,
        appsecret: sec,
        tr_id: 'FHPPG04650101',
        custtype: 'P',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const json = await res.json();
      if (json.rt_cd === '0' && Array.isArray(json.output) && json.output.length > 0) {
        const latest = json.output[0];
        const rawQty = parseInt(latest.whol_smtn_ntby_qty || '0', 10);
        const rawAmtWon = Number(latest.whol_smtn_ntby_tr_pbmn || '0');
        // 백만원 단위 정수 환산 (100만원 단위)
        const rawAmtMillion = Math.round(rawAmtWon / 1000000);
        // 🚨 [버그 수정 - 사용자 지적] KIS 공식 문서(apiportal) 재확인 결과 이 TR(FHPPG04650101)의
        // output에 acml_vol(누적 거래량) 필드가 실제로 존재한다 - "이 TR엔 거래량 필드가 없다"고
        // 판단해 ratioVsVolume을 0으로 고정한 건 잘못된 결론이었다. 실제 거래량으로 정상 계산한다.
        const rawVolume = parseInt(latest.acml_vol || '0', 10);

        // 장중 시계열 데이터 구성 (최대 30개 타임스탬프)
        const intradayTrend: ProgramTradeIntradayPoint[] = json.output
          .slice(0, 30)
          .reverse()
          .map((item: any) => {
            const hourRaw = item.bsop_hour || '';
            const formattedTime = hourRaw.length >= 4 ? `${hourRaw.slice(0, 2)}:${hourRaw.slice(2, 4)}` : hourRaw;
            const price = parseInt(item.stck_prpr || '0', 10) || currentPrice;
            const qty = parseInt(item.whol_smtn_ntby_qty || '0', 10);
            const amtMillion = Math.round(Number(item.whol_smtn_ntby_tr_pbmn || '0') / 1000000);

            return {
              time: formattedTime,
              price,
              totalNetBuyAmt: amtMillion,
              totalNetBuyQty: qty,
            };
          });

        let status: ProgramTradeSummary['status'] = 'NEUTRAL';
        if (rawAmtMillion > 500) status = 'STRONG_BUY';
        else if (rawAmtMillion > 100) status = 'BUY';
        else if (rawAmtMillion < -500) status = 'STRONG_SELL';
        else if (rawAmtMillion < -100) status = 'SELL';

        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000;
        const kstDate = new Date(utc + 9 * 60 * 60000);
        const hour = kstDate.getHours();
        const minute = kstDate.getMinutes();
        const timeNum = hour * 100 + minute;
        const dayOfWeek = kstDate.getDay();
        // 🚨 [버그 수정 - 애프터마켓 도입] getDynamicRankingTtl()과 동일한 이유로 15:30 ➔ 20:00.
        const isMarketOpen = isKrxMarketOpen(dayOfWeek, timeNum);

        const latestTime = latest.bsop_hour && latest.bsop_hour.length >= 4
          ? `${latest.bsop_hour.slice(0, 2)}:${latest.bsop_hour.slice(2, 4)}`
          : '';

        const programAsOfDateLabel = isMarketOpen
          ? (latestTime ? `당일 실시간 (${latestTime})` : '당일 실시간')
          : getSettledAsOfDateLabel();

        return {
          totalNetBuyAmt: rawAmtMillion,
          totalNetBuyQty: rawQty,
          ratioVsVolume: rawVolume > 0 ? Number(((Math.abs(rawQty) / rawVolume) * 100).toFixed(1)) : 0,
          status,
          asOfDateLabel: programAsOfDateLabel,
          intradayTrend,
        };
      }
    }
  } catch (e) {
    console.warn('[KIS Program Trade Fetch Exception]', e);
  }

  // 장마감 후 실시간 틱 API 실패 시: 1) 일별 확정치 API 및 2) 프로그램 랭킹 캐시에서 마감 확정치 복구 폴백
  let fallbackAmt = 0;
  let fallbackQty = 0;
  let fallbackVolume = 0;

  try {
    const dailyPoints = await fetchKisProgramTradeDaily(symbol, token, baseUrl, appKey, appSecret).catch(() => []);
    if (dailyPoints && dailyPoints.length > 0) {
      const latestDaily = dailyPoints[dailyPoints.length - 1];
      if (latestDaily && (latestDaily.totalNetBuyAmt !== 0 || latestDaily.totalNetBuyQty !== 0)) {
        fallbackAmt = latestDaily.totalNetBuyAmt;
        fallbackQty = latestDaily.totalNetBuyQty;
        fallbackVolume = latestDaily.volume;
      }
    }
  } catch { }

  // 랭킹 캐시에서도 확인
  for (const [key, cached] of rankingCacheStore.entries()) {
    if (cached && cached.type === 'program' && Array.isArray(cached.list)) {
      const match = cached.list.find((it) => it.symbol === symbol);
      if (match && match.netBuyAmt !== undefined) {
        fallbackAmt = match.netBuyAmt;
        fallbackQty = match.netBuyQty ?? fallbackQty;
        fallbackVolume = match.volume ?? fallbackVolume;
        break;
      }
    }
  }

  let fallbackStatus: ProgramTradeSummary['status'] = 'NEUTRAL';
  if (fallbackAmt > 500) fallbackStatus = 'STRONG_BUY';
  else if (fallbackAmt > 100) fallbackStatus = 'BUY';
  else if (fallbackAmt < -500) fallbackStatus = 'STRONG_SELL';
  else if (fallbackAmt < -100) fallbackStatus = 'SELL';

  return {
    totalNetBuyAmt: fallbackAmt,
    totalNetBuyQty: fallbackQty,
    ratioVsVolume: fallbackVolume > 0 ? Number(((Math.abs(fallbackQty) / fallbackVolume) * 100).toFixed(1)) : 0,
    status: fallbackStatus,
    asOfDateLabel: getSettledAsOfDateLabel(),
    intradayTrend: [],
  };
}

export interface ProgramTradeDailyPoint {
  date: string;
  totalNetBuyAmt: number; // 백만원 단위
  totalNetBuyQty: number;
  volume: number; // 누적 거래량(acml_vol) - ratioVsVolume 폴백 계산용
}

const programDailyMemoryCache = new Map<string, { data: ProgramTradeDailyPoint[]; timestamp: number }>();

export async function fetchKisProgramTradeDaily(
  symbol: string,
  token?: string,
  baseUrl?: string,
  appKey?: string,
  appSecret?: string
): Promise<ProgramTradeDailyPoint[]> {
  const cached = programDailyMemoryCache.get(symbol);
  const dynamicTtl = getDynamicRankingTtl();
  if (cached && Date.now() - cached.timestamp < dynamicTtl) {
    return cached.data;
  }

  try {
    const tk = token || (await getKisAccessToken());
    if (!tk) return [];

    const isVirtual = process.env.KIS_VIRTUAL === 'true';
    const defaultBaseUrl = isVirtual
      ? 'https://openapivts.koreainvestment.com:29443'
      : 'https://openapi.koreainvestment.com:9443';
    const urlBase = baseUrl || process.env.KIS_BASE_URL || defaultBaseUrl;
    const key = appKey || process.env.KIS_APPKEY || '';
    const sec = appSecret || process.env.KIS_APPSECRET || '';

    const today = new Date();
    const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDateObj = new Date(today);
    startDateObj.setDate(startDateObj.getDate() - 30);
    const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

    // 🚨 [버그 수정 - NXT 거래소 누락] program-trade-by-stock(실시간)과 같은 TR 계열이라 동일하게 UN 적용.
    // 단, 이 TR은 오늘 실측 시점에 응답 자체가 0건(장중 프로그램매매 데이터 없음)이라 J/NX/UN 값 차이를
    // 직접 비교 확인은 못 했다 - 같은 TR 계열(FHPPG0465xxxx)의 동일 파라미터 구조를 근거로 한 유추 적용.
    const url = `${urlBase}/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily?FID_COND_MRKT_DIV_CODE=UN&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${endDate}&FID_INPUT_DATE_2=${startDate}`;

    // 🚨 [버그 수정 - 근본 원인] fetchKisProgramTrade와 동일한 이유(위 1211번 줄 주석 참고) - 이 폴백 TR도
    // fetchKisProgramTrade의 kisQueue.enqueue() 콜백 내부에서 실행되므로, 타임아웃 없이 hang되면 똑같이
    // 전체 큐를 마비시킨다. 동일하게 8초 타임아웃을 추가한다.
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${tk}`,
        appkey: key,
        appsecret: sec,
        tr_id: 'FHPPG04650200',
        custtype: 'P',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const json = await res.json();
      if (json.rt_cd === '0' && Array.isArray(json.output)) {
        const points: ProgramTradeDailyPoint[] = json.output.map((d: any) => {
          const rawAmtWon = Number(d.whol_smtn_ntby_tr_pbmn || '0');
          const rawAmtMillion = Math.round(rawAmtWon / 1000000);
          const rawQty = parseInt(d.whol_smtn_ntby_qty || '0', 10);
          return {
            date: d.stck_bsop_date || '',
            totalNetBuyAmt: rawAmtMillion,
            totalNetBuyQty: rawQty,
            volume: parseInt(d.acml_vol || '0', 10),
          };
        });
        programDailyMemoryCache.set(symbol, { data: points, timestamp: Date.now() });
        return points;
      }
    }
  } catch (e) {
    console.warn('[KIS Program Trade Daily Exception]', e);
  }
  return [];
}

/**
 * In-memory cache for credit availability (symbol -> { isCredit, timestamp }) with 24-hour TTL
 */
interface CreditCacheEntry {
  isCredit: boolean;
  timestamp: number;
}
const creditStatusCache = new Map<string, CreditCacheEntry>();
const CREDIT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간 장기 캐싱

/**
 * KIS 주식현재가 시세조회 API (FHKST01010100)를 호출하여 신용가능 여부(crdt_able_yn) 반환 (전역 큐 LOW 우선순위 적용)
 */
export async function fetchKisCreditAvailable(symbol: string): Promise<boolean | undefined> {
  const now = Date.now();
  if (creditStatusCache.has(symbol)) {
    const entry = creditStatusCache.get(symbol)!;
    if (now - entry.timestamp < CREDIT_CACHE_TTL_MS) {
      return entry.isCredit;
    }
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '') {
    return undefined;
  }

  try {
    const isCredit = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisCreditAvailableFetch(symbol)),
      'LOW',
      `credit-${symbol}`
    );

    if (isCredit !== undefined) {
      creditStatusCache.set(symbol, { isCredit, timestamp: now });
    }
    return isCredit;
  } catch (e) {
    console.warn(`[Credit Inquiry Queue Error] ${symbol}:`, e);
    return undefined;
  }
}

async function executeKisCreditAvailableFetch(symbol: string): Promise<boolean | undefined> {
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;

  const token = await getKisAccessToken();
  if (!token) return undefined;

  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  // 🚨 [버그 수정 - 근본 원인] fetchKisCreditAvailable이 이 함수를 kisQueue.enqueue()(LOW 우선순위)로
  // 감싼다 - 타임아웃 없이 hang되면 동일하게 전체 큐가 마비된다(1211번 줄 참고). 8초 타임아웃을 추가한다.
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });

  if (res.ok) {
    const json = await res.json();
    if (json.rt_cd === '0' && json.output) {
      // Symbol Guard: Validate returned symbol against requested symbol to prevent cross-contamination
      const returnedSymbol = json.output.stck_shrn_iscd || json.output.mksc_shrn_iscd || '';
      if (returnedSymbol && returnedSymbol !== symbol) {
        console.warn(`[Symbol Mismatch Guard] Requested ${symbol} but KIS returned ${returnedSymbol}. Rejecting price update.`);
        return undefined;
      }

      const isCredit = json.output.crdt_able_yn === 'Y';
      const realPrice = parseInt(json.output.stck_prpr || '0', 10);
      const sign = json.output.prdy_vrss_sign || '3';
      let realChange = parseInt(json.output.prdy_vrss || '0', 10);
      if (sign === '4' || sign === '5') realChange = -Math.abs(realChange);
      const parsedRate = parseFloat(json.output.prdy_ctrt || '0');
      const realRate = isNaN(parsedRate) ? 0 : parsedRate;

      creditStatusCache.set(symbol, { isCredit, timestamp: Date.now() });

      if (realPrice > 0) {
        updateRuntimeStockPrice(symbol, realPrice, realChange, realRate);
      }
      // 🚨 [버그 수정] 이 응답(KIS 주식현재가 시세조회)엔 항상 hts_kor_isnm(한글 종목명)이 같이 오는데
      // 그동안 가격/신용여부만 뽑고 이름은 버리고 있었다 - stockMasterCache.json(정적 스냅샷이라 신규
      // 상장 종목 누락)/TOP_300/STOCK_NAME_MAP 4단계 정적 조회가 전부 실패하는 종목(예: 스카이랩스
      // 386380)이 검색창 헤더에 이름 대신 코드 그대로 뜨던 근본 원인이다. 새 API 호출 없이 이미 받는
      // 필드 하나만 더 읽어서 registerRuntimeStockName에 등록하면(updateRuntimeStockPrice와 동일한
      // 부산물 캐싱 패턴, 수칙 1-6) 이 함수가 호출되는 모든 화면(랭킹/뱃지/quotes 등)에서 자연스럽게
      // 이름 캐시가 채워진다.
      const realName = json.output.hts_kor_isnm || '';
      if (realName) {
        registerRuntimeStockName(symbol, realName);
      }
      return isCredit;
    }

    if (json.rt_cd !== '0') {
      throw new Error(`[KIS API Error] ${json.msg1 || json.msg_cd || json.rt_cd}`);
    }
  }

  if (res.status >= 500) {
    console.warn(`[KIS Server ${res.status} Temporary Failure] ${symbol} 신용/주가 조회 한투 서버 오류. 백그라운드 안전 스킵됨.`);
    return undefined;
  }
  throw new Error(`[KIS HTTP Error] Status ${res.status}`);
}

/**
 * 🚨 [성능 개선 - 사용자 지적: "장마감 후보군 로딩이 왜 이렇게 느리지"] 장마감 후보군(postmarket)이
 * 후보 종목당 오늘 시가/고가/저가/종가만 필요한데, 365일치 일봉+수급+프로그램매매까지 통째로 조회하는
 * 무거운 fetchKisInvestorTrend(최대 5회 순차 KIS 호출)를 쓰고 있어 콜드 상태에서 실측 15~40초가 걸렸다.
 * 바로 위 executeKisCreditAvailableFetch가 이미 이 정보를 갖고 있는 FHKST01010100을 호출하면서
 * 현재가만 뽑고 시가/고가/저가는 버리고 있었다 - 동일 API를 재사용해 단일 호출(8초 타임아웃, LOW 큐)로
 * 끝낸다. 신용가능 캐시(24시간, 하루 안 바뀜)와 당일 고가/저가(장중 계속 바뀜)는 갱신 주기가 근본적으로
 * 달라 같은 캐시에 얹으면 수칙 1-5와 같은 문제가 생기므로, executeKisCreditAvailableFetch 자체는 건드리지
 * 않고(앱 전체가 의존하는 민감한 경로라 리스크를 최소화) 별도의 짧은 TTL 경량 함수로 분리한다(수칙 1-6 -
 * 중복이 불가피한 이유를 명시).
 */
interface DailyPriceCacheEntry {
  open: number;
  high: number;
  low: number;
  close: number;
  changeRate: number;
  timestamp: number;
}
const dailyPriceCache = new Map<string, DailyPriceCacheEntry>();

export async function fetchKisDailyPrice(
  symbol: string
): Promise<{ open: number; high: number; low: number; close: number; changeRate: number } | undefined> {
  const cached = dailyPriceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < getDynamicRankingTtl()) {
    return cached;
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '') return undefined;

  try {
    const result = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisDailyPriceFetch(symbol)),
      'LOW',
      `daily-price-${symbol}`
    );
    if (result) {
      dailyPriceCache.set(symbol, { ...result, timestamp: Date.now() });
    }
    return result;
  } catch (e) {
    console.warn(`[Daily Price Inquiry Queue Error] ${symbol}:`, e);
    return undefined;
  }
}

async function executeKisDailyPriceFetch(
  symbol: string
): Promise<{ open: number; high: number; low: number; close: number; changeRate: number } | undefined> {
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;

  const token = await getKisAccessToken();
  if (!token) return undefined;

  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });

  // 🚨 [버그 수정 - 사용자 지적: "눌림저항 -인 애들은 뭐야?"] 이 "5xx 무재시도" 패턴은 원래
  // executeKisCreditAvailableFetch(1803행)의 신용상태 배치용으로 만들어졌다 - 거긴 creditStatusCache에
  // 장기 TTL로 캐시되고 랭킹 테이블이 주기적으로 재조회하면서 자연스럽게 재시도되니 5xx를 그냥 넘겨도
  // 무해했다. 그런데 이 함수(발굴/전조 enrichment에서도 재사용됨, 5019/5258/5518행)는 하루 한 번만
  // 도는 스냅샷 배치라 그런 자연 재시도가 없다 - 5xx를 조용히 넘기면 다음날 크론까지 "-"로 영구히
  // 남는다(실측: 09/22 14:30 배치에서 SFA반도체·한전기술·삼성전기 등 6종목 확인, 재호출 시 전부 정상).
  // fetchWithRetry(최대 3회, 600ms 백오프)가 이미 감싸고 있으니 그냥 throw로 맡긴다(수칙 1-6).
  if (!res.ok) {
    throw new Error(`[KIS HTTP Error] Status ${res.status} (daily-price ${symbol})`);
  }

  const json = await res.json();
  if (json.rt_cd !== '0' || !json.output) {
    throw new Error(`[KIS API Error] ${json.msg1 || json.msg_cd || json.rt_cd}`);
  }

  const returnedSymbol = json.output.stck_shrn_iscd || json.output.mksc_shrn_iscd || '';
  if (returnedSymbol && returnedSymbol !== symbol) {
    console.warn(`[Symbol Mismatch Guard] Requested ${symbol} but KIS returned ${returnedSymbol}. Rejecting daily price.`);
    return undefined;
  }

  const open = parseInt(json.output.stck_oprc || '0', 10);
  const high = parseInt(json.output.stck_hgpr || '0', 10);
  const low = parseInt(json.output.stck_lwpr || '0', 10);
  const close = parseInt(json.output.stck_prpr || '0', 10);
  const parsedRate = parseFloat(json.output.prdy_ctrt || '0');
  const changeRate = isNaN(parsedRate) ? 0 : parsedRate;

  // 이왕 받은 응답을 부산물로 캐싱한다(executeKisCreditAvailableFetch와 동일한 관례, 수칙 1-6) -
  // 신용가능/종목명 조회가 이 응답을 놓친 채 또 KIS를 부르지 않아도 되게.
  if (json.output.crdt_able_yn !== undefined) {
    creditStatusCache.set(symbol, { isCredit: json.output.crdt_able_yn === 'Y', timestamp: Date.now() });
  }
  const realName = json.output.hts_kor_isnm || '';
  if (realName) {
    registerRuntimeStockName(symbol, realName);
  }

  return { open, high, low, close, changeRate };
}

/**
 * 🚨 [버그 수정 - 사용자 지적: 로보티즈(108490) 신용불가인데 신용가능으로 오표시]
 * 원래 여기 있던 creditBatchStore(Map)/creditBatchTimeLabel/getCreditBatchTimeLabel()는
 * "일별 08:30 배치 캐시"라는 주석과 달리 실제로는 batchCollector.ts 어디에도 이걸 채우는
 * 크론 로직이 없어(grep 확인: .set() 호출 0건) 항상 빈 Map으로만 존재하던 죽은 코드였다.
 * getCreditBatchTimeLabel()도 어디서도 호출되지 않는 미사용 함수였다(grep 확인: 외부 참조 0건).
 * 실제로는 이 죽은 1차 관문 때문에 creditStatusCache(개별/Supabase 실조회 캐시)도 비어있는
 * 종목은 곧장 최종 폴백 `return true`로 떨어졌다 - 즉 "확인 안 된 종목은 무조건 신용가능"으로
 * 확정해버리는 가상 하드코딩이었다(수칙 1-3 위반). 실측: 로보티즈 KIS crdt_able_yn 원본은
 * "N"(신용불가)인데 이 함수는 true를 반환했다. 진짜 3번째 상태(undefined="확인필요")를
 * 함수 시그니처(boolean | undefined)가 애초에 약속하고 있었으므로, 근거 없는 종목을
 * 함부로 true로 단정하지 않고 정직하게 undefined를 반환하도록 원상복구한다.
 */

/**
 * 3-상태 신용가능 여부 단일 공용 평가 함수 (Single Source of Truth)
 * - false: ETF/ETN 또는 확정된 신용불가 종목
 * - true: 확정된 신용가능 종목
 * - undefined: 미캐시 / 조회 중 (모바일 종목상세 배지: MobileStockDetailChart.tsx가 '신용 확인필요'로 표시)
 */
export function getEvaluatedCreditStatus(symbol: string, name?: string): boolean | undefined {
  // 종목코드만으로도 마스터 그룹코드(EF)로 판별 가능 - 이름 없이 호출돼도 ETF는 신용불가로 확정
  if (isEtfSymbol(symbol, name || '')) {
    return false;
  }
  if (creditStatusCache.has(symbol)) {
    return creditStatusCache.get(symbol)!.isCredit;
  }
  const knownNonCredit = ['293490', '293500', '066970', '060310', '011170'];
  if (knownNonCredit.includes(symbol)) {
    return false;
  }
  // 캐시에도 없고 하드코딩 확정 리스트에도 없는 종목은 실제 KIS 값을 모르는 것이므로
  // 임의로 true/false를 단정하지 않고 미확인 상태(undefined)로 정직하게 반환한다.
  return undefined;
}

/**
 * 랭킹 종목 리스트에 대해 로컬 배치 캐시의 신용가능 여부 즉시 병합 (0ms, 불변 객체 생성)
 */
export async function mergeCreditStatusToRanking(items: RankingItem[]): Promise<RankingItem[]> {
  if (!items || items.length === 0) return items;

  // 1. Instant ETF / ETN 0ms Filter: Mark all ETFs/ETNs as isCreditAvailable: false
  items.forEach((item) => {
    if (isEtfSymbol(item.symbol, item.name)) {
      creditStatusCache.set(item.symbol, { isCredit: false, timestamp: Date.now() });
    }
  });

  // 2. Identify symbols still missing from memory cache
  const missingSymbols: string[] = [];
  items.forEach((item) => {
    if (!creditStatusCache.has(item.symbol)) {
      missingSymbols.push(item.symbol);
    }
  });

  // 3. Batch Supabase DB check for missing symbols
  // 🚨 [버그 수정 - 사용자 지적: "두산에너빌리티는 신용 가능한데 왜 자꾸 가능했다가 안됐다고 뜨는거야?
  // 한번 저장하면 계속 쓰는거 아니었어?"] 예전엔 Supabase에 행이 있기만 하면 그게 몇 주 전 값이든 그대로
  // 신뢰해서 timestamp: Date.now()로 "방금 확인한 것처럼" 메모리 캐시에 24시간 도장을 찍었다 - 실측:
  // 두산에너빌리티(034020)가 8/28 저장된 is_credit:false를 오늘(KIS 라이브 원본은 Y=가능)도 그대로
  // 물려받고 있었다. 이제 저장된 시각(updatedAtMs)이 CREDIT_CACHE_TTL_MS(24시간) 이내인 행만 신뢰하고,
  // timestamp도 지금 시각이 아니라 실제 저장 시각을 그대로 써서 메모리 캐시의 24시간 TTL이 "진짜 확인된
  // 시점" 기준으로 정확히 계산되게 한다. 24시간 넘은 행은 신뢰하지 않고 "미확인" 상태로 남겨서, 아래
  // 호출부(ranking/surging route의 after() 백그라운드 로직)가 isCreditAvailable===undefined로 보고
  // 실시간 KIS 재검증 + Supabase 재저장 대상에 자동으로 포함시킨다(수칙 1-6, 기존 재검증 경로 재사용 -
  // 새 크론 없음).
  if (missingSymbols.length > 0) {
    // 3a. Supabase DB Check (Instant DB Read)
    const supabaseMap = await fetchCreditBatchFromSupabase(missingSymbols).catch(() => ({} as Record<string, CreditBatchRow>));
    const now = Date.now();
    missingSymbols.forEach((sym) => {
      const row = supabaseMap?.[sym];
      if (row && now - row.updatedAtMs < CREDIT_CACHE_TTL_MS) {
        creditStatusCache.set(sym, { isCredit: row.isCredit, timestamp: row.updatedAtMs });
      }
    });
  }

  return items.map((item) => ({
    ...item,
    isCreditAvailable: getEvaluatedCreditStatus(item.symbol, item.name),
  }));
}

/**
 * Next.js after() 콜백에서 호출되는 백그라운드 KIS 신용조회 및 Supabase DB 저장 함수
 */
export async function resolveAndCacheMissingCredits(symbols: string[]): Promise<void> {
  if (!symbols || symbols.length === 0) return;
  const unCached = symbols.filter((sym) => !creditStatusCache.has(sym));
  if (unCached.length === 0) return;

  const entries: Array<{ symbol: string; is_credit: boolean }> = [];
  const chunkSize = 5; // 5개씩 병렬 묶음 처리하여 KIS EGW00201 초당 건수제한 무해성 보장

  for (const sym of unCached) {
    try {
      await enforceRateLimit();
      const isCredit = await fetchKisCreditAvailable(sym);
      if (isCredit !== undefined) {
        creditStatusCache.set(sym, { isCredit, timestamp: Date.now() });
        entries.push({ symbol: sym, is_credit: isCredit });
      }
    } catch (e) { }
  }

  if (entries.length > 0) {
    const saved = await saveCreditBatchToSupabase(entries);
    console.log(`[Supabase kis_credits Saved] ${entries.length}개 종목 신용상태 DB 저장 완료 (성공: ${saved})`);
  }
}

/**
 * KIS 국내기관/외국인 매매종목가집계 랭킹 API 호출 (FHPTJ04400000)
 * 공식 GitHub 저장소(koreainvestment/open-trading-api) 명세와 동일하게 파라미터 구성:
 * - FID_COND_MRKT_DIV_CODE: 'V'
 * - FID_COND_SCR_DIV_CODE: '16449'
 * - FID_INPUT_ISCD: '0000'
 * - FID_DIV_CLS_CODE: '0' (0: 수량정렬, 1: 금액정렬)
 * - FID_RANK_SORT_CLS_CODE: '0' (순매수상위) / '1' (순매도상위)
 * - FID_ETC_CLS_CODE: '1' (외국인) / '2' (기관계)
 */
const rankingCacheStore = getGlobalMap<string, InvestorRankingResponse>('rankingCacheStore');

export async function fetchKisForeignInstitutionRanking(
  type: 'foreign' | 'organ' = 'foreign',
  direction: 'buy' | 'sell' = 'buy',
  period: '1d' | '1w' | '1m' = '1d',
  market: MarketType = 'ALL',
  limit?: number
): Promise<InvestorRankingResponse> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;

  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  const cacheKey = `foreign-inst-${type}-${direction}-${period}-${market}-${limit || 50}`;
  const dynamicTtl = getDynamicRankingTtl();

  if (rankingCacheStore.has(cacheKey)) {
    const cached = rankingCacheStore.get(cacheKey)!;
    if (Date.now() - new Date(cached.updatedAt).getTime() < dynamicTtl) {
      return cached;
    }
  }

  // 🚨 [모바일 콜드스타트 지연 수정] 수급교집합(fetchOverlapRankingData, 위 2419번 줄)만 이 Supabase
  // "완전판"(full: 접두사) 캐시가 있어서 콜드 인스턴스에서도 0.5초대였는데, 외국인/기관은
  // 인메모리 캐시(rankingCacheStore)뿐이라 새 서버리스 인스턴스에 걸릴 때마다 KIS 실시간 API를
  // 처음부터 다시 타서 실측 42초까지 걸렸다(scratch/diagnose_mobile_tab_speed.js 프로덕션 실측,
  // 사용자 지적 "교집합탭 빼고는 왤케 다 느려?"의 실제 원인). 동일 패턴을 그대로 적용한다.
  // 🚨 [버그 수정 - 근본 원인] 처음엔 수급교집합과 똑같이 maxAge=24시간을 그대로 복사해왔는데, 수급교집합은
  // "당일 하루 종일 사실상 고정"이 의도된 설계(getDynamicRankingTtl 주석 참고)라 24시간이 맞지만,
  // 외국인/기관은 정반대로 "장중 60초마다 실시간 가집계 반영"이 의도된 설계다(같은 함수의 다른 분기).
  // 24시간을 그대로 쓰면 한 번 라이브로 받아온 스냅샷이 최대 24시간 동안 계속 재사용되면서 실시간
  // 가집계가 사실상 멈출 수 있었다("어제랑 똑같아 보인다"는 사용자 의심 계기로 발견).
  // 🚨 [2차 재발 - 버그 수정] 그래서 인메모리 캐시와 똑같이 dynamicTtl(장중 60초)로 맞췄었는데, 이게
  // 3479~3485번 줄의 2일/3일연속 교집합에서 이미 한 번 겪었던 것과 똑같은 설계 실수였다 - "이 프로세스가
  // 얼마나 자주 재계산할지"(로컬 TTL)와 "다른 인스턴스/환경이 얼마나 오래된 공유 캐시를 믿고 재사용해도
  // 되는지"(Supabase 폴백 유효기간)는 서로 다른 질문인데 같은 값으로 묶어버렸다. 60초는 인스턴스가 여러
  // 개 떠서 서로 자주 갱신해주는 프로덕션 고트래픽 환경에서나 겨우 맞아떨어지고, 사용자 로컬 개발 서버처럼
  // 트래픽이 뜸한 환경에서는 "누군가 60초 이내에 이미 계산해뒀을" 확률이 거의 0이라 매번 라이브 재계산을
  // 그대로 겪는다(실측: 사용자 로컬에서 foreign 25.8초, organ 24.9초, 이를 내부적으로 또 호출하는 급등주
  // 교집합(overlap)은 106초). 그래서 한때 5분 고정값으로 절충했었다.
  // 🚨 [3차 재발 - 버그 수정 - 사용자 지적: "모바일 급등주 교집합 왜 또 로딩 긴데. 지금은 장도 다
  // 끝낫구만"] 실측(프로덕션, 장마감 후 21시): "기관" 탭이 16~20초 걸림 - 5분 고정값은 "장중 트래픽이
  // 뜸한 로컬 개발"만 감안했지, "장마감 후 트래픽 자체가 뜸해지는 시간대"는 감안 못 했다. 장마감 후엔
  // 데이터가 어차피 안 바뀌므로 5분이 아니라 훨씬 길게 캐시해도 무방한데, 5분마다 콜드스타트를 반복
  // 겪은 것. fetchOverlapRankingData/fetchConsecutiveNDaysOverlapRankingData가 이미 쓰고 있는
  // getSharedCacheMaxAgeMs()(장중 60초 / 장마감 후 다음 마감 경계까지)로 통일한다(수칙 1-6) - 이
  // 함수가 나오기 전에 5분으로 절충했던 임시방편을 이제 제거한다. 장중엔 60초로 더 신선해지고, 장마감
  // 후엔 콜드스타트가 사라진다.
  const sharedMap = await fetchSharedRankCacheBatch([`full:${cacheKey}`], getSharedCacheMaxAgeMs()).catch(() => new Map<string, any[]>());
  const sharedList = sharedMap.get(`full:${cacheKey}`);
  if (sharedList && sharedList.length > 0) {
    console.log(`[Shared Rank Cache Hit] full:${cacheKey} - 다른 인스턴스가 이미 계산해둔 ${type} 랭킹을 Supabase에서 재사용`);
    const sharedRes: InvestorRankingResponse = {
      type,
      direction,
      period,
      list: sharedList,
      isMock: false,
      // 🚨 [버그 수정 - 애프터마켓 진단 중 발견, fetchOverlapRankingData와 동일한 원인(수칙 1-6)]
      // 이 콜드스타트 폴백 경로가 top-level asOfDateLabel을 안 채워서, 이 함수를 호출하는
      // executeAsyncOverlapCalculation의 `foreignRes.asOfDateLabel || getSettledAsOfDateLabel()`이
      // 항상 후자로 떨어져 당일교집합 최상위 라벨이 시간과 무관하게 "(9/16 기준)"으로 고정됐었다.
      asOfDateLabel: sharedList[0]?.asOfDateLabel,
      updatedAt: new Date().toISOString(),
    };
    rankingCacheStore.set(cacheKey, sharedRes);
    return sharedRes;
  }

  try {
    const res = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisForeignInstitutionRankingFetch(type, direction, period, market, limit)),
      'NORMAL',
      cacheKey
    );
    if (res && res.list && res.list.length > 0) {
      rankingCacheStore.set(cacheKey, res);
      syncSharedRankCache(cacheKey, res.list);
      // 뱃지 요약 경량본(syncSharedRankCache)과 별개로, 완전한 RankingItem 전체를 'full:' 접두사에 저장 -
      // 위 콜드스타트 읽기 폴백이 실제로 쓸 수 있는 유일한 소스다.
      upsertSharedRankCache(`full:${cacheKey}`, res.list).catch(() => {});
    }
    return res;
  } catch (err: any) {
    if (rankingCacheStore.has(cacheKey)) {
      const cached = rankingCacheStore.get(cacheKey)!;
      return {
        ...cached,
        lastBatchTime: '장 마감 - 최근 마감 데이터 기준',
        updatedAt: new Date().toISOString(),
      };
    }
    throw err;
  }
}

async function executeKisForeignInstitutionRankingFetch(
  type: 'foreign' | 'organ' = 'foreign',
  direction: 'buy' | 'sell' = 'buy',
  period: '1d' | '1w' | '1m' = '1d',
  market: MarketType = 'ALL',
  limit?: number
): Promise<InvestorRankingResponse> {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  const token = await getKisAccessToken();
  if (!token) {
    const detail = globalThis.__lastKisOAuthError__ || 'KIS 오픈API Access Token 발급 실패 (인증키 설정 및 KIS 서버 거부 상태 확인 필요)';
    throw new Error(`[KIS API 인증 오류] ${detail}`);
  }

  const etcClsCode = type === 'foreign' ? '1' : '2';
  const rankSortClsCode = direction === 'buy' ? '0' : '1';
  const divClsCode = '1';

  let rawOutputs: any[] = [];
  if (market === 'ALL') {
    // 당일(1d) market=ALL: 코스피(0001) 30개 + 코스닥(1001) 30개 동시 병렬 호출로 총 60개 확보 후 50개 추출
    const urlKospi = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=0001&FID_DIV_CLS_CODE=${divClsCode}&FID_RANK_SORT_CLS_CODE=${rankSortClsCode}&FID_ETC_CLS_CODE=${etcClsCode}`;
    const urlKosdaq = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=1001&FID_DIV_CLS_CODE=${divClsCode}&FID_RANK_SORT_CLS_CODE=${rankSortClsCode}&FID_ETC_CLS_CODE=${etcClsCode}`;

    const fetchOptions = {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHPTJ04400000',
        custtype: 'P',
      },
      cache: 'no-store' as const,
      signal: AbortSignal.timeout(8000),
    };

    await enforceRateLimit();
    const [resKospi, resKosdaq] = await Promise.all([
      fetch(urlKospi, fetchOptions).catch(() => null),
      fetch(urlKosdaq, fetchOptions).catch(() => null),
    ]);

    const jsonKospi = resKospi && resKospi.ok ? await resKospi.json().catch(() => null) : null;
    const jsonKosdaq = resKosdaq && resKosdaq.ok ? await resKosdaq.json().catch(() => null) : null;

    const listKospi = (jsonKospi && jsonKospi.rt_cd === '0' && Array.isArray(jsonKospi.output)) ? jsonKospi.output : [];
    const listKosdaq = (jsonKosdaq && jsonKosdaq.rt_cd === '0' && Array.isArray(jsonKosdaq.output)) ? jsonKosdaq.output : [];
    const baseAll = [...listKospi, ...listKosdaq];
    const existingSymbolsAll = new Set(baseAll.map((i: any) => i.mksc_shrn_iscd || i.stck_shrn_iscd));

    // 🚨 [버그 수정 - 수칙 1-6: 동일 로직 중복 구현] market!=='ALL' 분기(아래 else)는 이미 getCached5dTrend로
    // 실제 캐시된 종가/수급을 써서 30(60)위 밖 종목을 정석대로 보강하는데, 이 market==='ALL' 분기만
    // 그 정석 로직 없이 stck_prpr(현재가)를 basePrice(하드코딩 기본가)로, prdy_ctrt(등락률)를 '0'으로,
    // acml_vol(거래량)을 '1000000'으로 통째로 가짜 채워 넣고 있었다(수칙 1-3 위반: 임시 가상 숏컷 금지).
    // 이게 SK이노베이션 등 "외국인/기관 매매종목가집계" 상위 30(60)위 밖인데도 TOP_300 상위 50위 안에
    // 드는 종목들이 항상 더미 가격(basePrice)으로 계산돼 이격도/배지가 틀리게 나오던 진짜 근본 원인이었다
    // - KIS API 장애나 장마감과 무관하게, API가 순위를 안 줬다는 이유만으로 매번 재현되는 구조적 결함.
    // else 분기와 동일하게 getCached5dTrend(배치 예열 캐시의 실제 최근 종가)를 우선 쓰도록 통일한다.
    const { getCached5dTrend: getCached5dTrendForAll, warmCached5dTrendFromSupabase: warmAll } = await import('./batchCollector');
    // 🚨 [버그 수정 - 기관 순매수 랭킹 42개 원인] 이 인스턴스가 아직 직접 예열 못 한 종목도 다른
    // 인스턴스가 Supabase에 저장해둔 값이 있으면 재사용하도록 먼저 배치 조회로 채운다.
    await warmAll(TOP_300_STOCKS.slice(0, 50).map((s) => s.symbol));
    const extraAll: any[] = [];
    TOP_300_STOCKS.slice(0, 50).forEach((stock) => {
      if (existingSymbolsAll.has(stock.symbol)) return;
      const trendRes = getCached5dTrendForAll(stock.symbol);
      const trendList = trendRes?.trend || [];
      const latest = trendList.length > 0 ? trendList[trendList.length - 1] : null;
      const foreignAmt = latest?.foreignNetBuyAmt || trendRes?.summary?.foreign?.todayEstimateAmt || 0;
      const foreignQty = latest?.foreignNetBuyQty || trendRes?.summary?.foreign?.todayEstimateQty || 0;
      const organAmt = latest?.organNetBuyAmt || trendRes?.summary?.organ?.todayEstimateAmt || 0;
      const organQty = latest?.organNetBuyQty || trendRes?.summary?.organ?.todayEstimateQty || 0;
      const amt = type === 'foreign' ? foreignAmt : organAmt;
      if (amt === 0) return; // else 분기와 동일한 기준: 실제 순매수가 없는 종목은 애초에 후보로 안 넣는다
      extraAll.push({
        mksc_shrn_iscd: stock.symbol,
        hts_kor_isnm: stock.name,
        market: stock.market,
        stck_prpr: String(latest?.closePrice || stock.basePrice || 50000),
        prdy_vrss: String(latest?.priceChange || 0),
        prdy_ctrt: String(latest?.changeRate || 0),
        acml_vol: String(latest?.volume || 1000000),
        frgn_ntby_tr_pbmn: type === 'foreign' ? String(foreignAmt) : '0',
        frgn_ntby_qty: type === 'foreign' ? String(foreignQty) : '0',
        orgn_ntby_tr_pbmn: type === 'organ' ? String(organAmt) : '0',
        orgn_ntby_qty: type === 'organ' ? String(organQty) : '0',
      });
    });

    rawOutputs = [...baseAll, ...extraAll];
  } else {
    const inputIscd = market === 'KOSPI' ? '0001' : '1001';
    const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/foreign-institution-total?FID_COND_MRKT_DIV_CODE=V&FID_COND_SCR_DIV_CODE=16449&FID_INPUT_ISCD=${inputIscd}&FID_DIV_CLS_CODE=${divClsCode}&FID_RANK_SORT_CLS_CODE=${rankSortClsCode}&FID_ETC_CLS_CODE=${etcClsCode}`;

    await enforceRateLimit();
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHPTJ04400000',
        custtype: 'P',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[KIS Ranking Error]`, res.status, errText);
      throw new Error(`[KIS API 매매순위 호출 오류 ${res.status}] ${errText}`);
    }

    const json = await res.json();
    // rt_cd(응답코드) 자체가 실패이거나 output이 배열이 아닌 경우만 진짜 오류로 재시도 유도.
    // rt_cd='0'(정상처리)인데 output만 0건인 경우는 KIS 측 순간 공백 응답일 뿐 API 장애가 아니므로,
    // market==='ALL' 분기와 동일하게 에러로 던지지 않고 TOP_300 실데이터 보강으로 자연스럽게 대체한다.
    if (json.rt_cd !== '0' || !Array.isArray(json.output)) {
      throw new Error(`[KIS API 매매순위 응답 오류] ${json.msg1 || json.msg_cd || '응답 데이터 없음'}`);
    }
    if (json.output.length === 0) {
      console.warn(`[KIS Ranking Empty Output] ${type}-${direction}-${market}: rt_cd=0 정상이나 output 0건 - TOP_300 실데이터 보강으로 대체`);
    }

    const baseOutputs = json.output || [];
    const existingSymbols = new Set(baseOutputs.map((i: any) => i.mksc_shrn_iscd || i.stck_shrn_iscd));

    // TOP_300_STOCKS 중 해당 시장 종목들의 당일 실데이터로 30위 밖 보강 (50개 충족)
    const { getCached5dTrend, warmCached5dTrendFromSupabase } = await import('./batchCollector');
    const marketStocks = TOP_300_STOCKS.filter((s) => s.market === market && !existingSymbols.has(s.symbol));
    // 🚨 [버그 수정 - 기관 순매수 랭킹 42개 원인] market==='ALL' 분기와 동일하게, 이 인스턴스가 아직
    // 직접 예열 못 한 종목도 다른 인스턴스가 Supabase에 저장해둔 값이 있으면 먼저 재사용한다.
    await warmCached5dTrendFromSupabase(marketStocks.map((s) => s.symbol));
    const extraOutputs: any[] = [];

    for (const stock of marketStocks) {
      const trendRes = getCached5dTrend(stock.symbol);
      const trendList = trendRes?.trend || [];
      const latest = trendList.length > 0 ? trendList[trendList.length - 1] : null;
      const amt = type === 'foreign'
        ? (latest?.foreignNetBuyAmt || trendRes?.summary?.foreign?.todayEstimateAmt || 0)
        : (latest?.organNetBuyAmt || trendRes?.summary?.organ?.todayEstimateAmt || 0);

      const qty = type === 'foreign'
        ? (latest?.foreignNetBuyQty || trendRes?.summary?.foreign?.todayEstimateQty || 0)
        : (latest?.organNetBuyQty || trendRes?.summary?.organ?.todayEstimateQty || 0);

      if (amt !== 0) {
        extraOutputs.push({
          mksc_shrn_iscd: stock.symbol,
          hts_kor_isnm: stock.name,
          market: stock.market,
          stck_prpr: String(latest?.closePrice || stock.basePrice || 50000),
          prdy_vrss: String(latest?.priceChange || 0),
          prdy_ctrt: String(latest?.changeRate || 0),
          acml_vol: String(latest?.volume || 1000000),
          frgn_ntby_tr_pbmn: type === 'foreign' ? String(amt) : '0',
          frgn_ntby_qty: type === 'foreign' ? String(qty) : '0',
          orgn_ntby_tr_pbmn: type === 'organ' ? String(amt) : '0',
          orgn_ntby_qty: type === 'organ' ? String(qty) : '0',
        });
      }
    }

    rawOutputs = [...baseOutputs, ...extraOutputs];
  }

  try {
    const list: RankingItem[] = rawOutputs.map((item: any, idx: number) => {
      const symbol = item.mksc_shrn_iscd || item.stck_shrn_iscd || '';
      const rawName = item.hts_kor_isnm || item.kor_isnm || item.isnm || item.hts_kor_isnm_1;
      const name = getStockName(symbol, rawName);

      const sign = item.prdy_vrss_sign || '3';
      let priceChange = parseInt(item.prdy_vrss || item.prss || '0', 10);
      if (sign === '4' || sign === '5') priceChange = -Math.abs(priceChange);
      const parsedRate = parseFloat(item.prdy_ctrt || item.ctrt || '0');
      const changeRate = isNaN(parsedRate) ? 0 : parsedRate;
      const volume = parseInt(item.acml_vol || item.vol || '0', 10);

      const rawPrice = Math.abs(parseInt(
        item.stck_prpr || item.prpr || item.stck_clpr || item.stck_prdy_clpr || item.stck_prdy_prpr || item.stck_sdpr || '0',
        10
      ));

      const priceInfo = resolveStockPriceAndChange(symbol, rawPrice, priceChange, changeRate);

      const rawPbmn = type === 'foreign'
        ? parseInt(item.frgn_ntby_tr_pbmn || item.frgn_ntby_amt || item.ntby_tr_pbmn || '0', 10)
        : parseInt(item.orgn_ntby_tr_pbmn || item.orgn_ntby_amt || item.ntby_tr_pbmn || '0', 10);

      const rawQty = type === 'foreign'
        ? parseInt(item.frgn_ntby_qty || item.frgn_ntby_vol || item.ntby_qty || '0', 10)
        : parseInt(item.orgn_ntby_qty || item.orgn_ntby_vol || item.ntby_qty || '0', 10);

      const netBuyAmt = rawPbmn;
      const netBuyAmtEok = Number((rawPbmn / 100).toFixed(1));
      const netBuyQty = rawQty;
      const ratioVsVolume = volume > 0 ? Number(((Math.abs(rawQty) / volume) * 100).toFixed(1)) : 0;

      const itemMarket: MarketType = resolveMarketType(symbol, name, market !== 'ALL' ? market : (item as any).market);

      return {
        rank: idx + 1,
        symbol,
        name,
        market: itemMarket,
        currentPrice: priceInfo.currentPrice,
        change: priceInfo.change,
        changeRate: priceInfo.changeRate,
        netBuyQty,
        netBuyAmt,
        netBuyAmtEok,
        volume,
        ratioVsVolume,
        isCreditAvailable: getEvaluatedCreditStatus(symbol, name),
      };
    });

    const isBuy = direction === 'buy';
    list.sort((a, b) => (isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt));
    list.forEach((item, idx) => {
      item.rank = idx + 1;
    });

    // 100% 배치 스토어 및 Supabase DB 병합 (0ms~10ms)
    const mergedList = await mergeCreditStatusToRanking(list);

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const kstDate = new Date(utc + 9 * 60 * 60000);
    const hour = kstDate.getHours();
    const minute = kstDate.getMinutes();
    const timeNum = hour * 100 + minute;
    const dayOfWeek = kstDate.getDay();
    // 🚨 [버그 수정 - 사용자 지적: "애프터마켓까지 살아있게 고치는게 맞지않을까?"] 15:30 ➔ 20:00 -
    // 이 경계가 false가 되는 순간 아래에서 전 종목을 마감 확정치로 굳혀버리는데(다음 영업일 08:30까지
    // 다시 안 풂), 애프터마켓 도입 전엔 15:30이 진짜 마감이라 맞았지만 지금은 20:00까지 실거래가 있다.
    const isMarketOpen = isKrxMarketOpen(dayOfWeek, timeNum);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    // 1주일(1w)/1개월(1m) 탭이거나 장마감 후(!isMarketOpen)에는 상단 카드와 100% 동일한 FHKST01010900 마감 확정치로 전수 보정 및 재정렬
    if (!isMarketOpen || period !== '1d' || mergedList.every((item) => item.netBuyAmt === 0)) {
      await enrichRankingWithRawInvestorData(mergedList, type, direction, period);
      // 마감 확정치 갱신 후 순매수/순매도 방향에 따라 재정렬
      mergedList.sort((a, b) => (isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt));
      mergedList.forEach((item, idx) => {
        item.rank = idx + 1;
      });
    }

    const slicedList = limit && limit > 0 ? mergedList.slice(0, limit) : mergedList;

    const rankingAsOfDateLabel = isMarketOpen
      ? `당일 가집계 (${timeStr} 기준)`
      : getSettledAsOfDateLabel();
    const lastBatchTime = isMarketOpen ? `${timeStr} 기준` : getSettledAsOfDateLabel();

    // 🚨 [버그 수정] getCached5dTrend(라이브 예열 캐시)에만 의존했었다 - 그게 비어있으면(실측: 93개
    // 종목 전부) computeStatusBadgeFromTrend가 예외 없이 "이평선 수렴" fallback을 반환해 program/
    // overlap 다른 탭과 어긋났다. resolveTrendForBadge로 통일(DB 1순위)한다 - 수칙 1-6.
    const finalList = await Promise.all(
      slicedList.map(async (item) => {
        const trendData = await resolveTrendForBadge(item.symbol, {
          currentPrice: item.currentPrice,
          change: item.change,
          changeRate: item.changeRate,
          volume: item.volume,
        });
        const statusInfo = computeStatusBadgeFromTrend(trendData);
        return {
          ...item,
          statusBadge: statusInfo?.shortBadge,
          statusBadgeStyle: statusInfo?.badgeStyle,
          asOfDateLabel: item.asOfDateLabel || rankingAsOfDateLabel,
        };
      })
    );

    return {
      type,
      direction,
      period,
      list: finalList,
      isMock: false,
      lastBatchTime,
      asOfDateLabel: rankingAsOfDateLabel,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[KIS Ranking Exception]', err);
    throw err;
  }
}

async function enrichRankingWithRawInvestorData(
  list: RankingItem[],
  type: 'foreign' | 'organ',
  direction: 'buy' | 'sell',
  period: RankingPeriod = '1d'
) {
  try {
    const appKey = process.env.KIS_APPKEY;
    const appSecret = process.env.KIS_APPSECRET;
    if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') return;
    const token = await getKisAccessToken();
    if (!token) return;

    const isVirtual = process.env.KIS_VIRTUAL === 'true';
    const defaultBaseUrl = isVirtual
      ? 'https://openapivts.koreainvestment.com:29443'
      : 'https://openapi.koreainvestment.com:9443';
    const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

    // 하드코딩 개수 제한 없이 list 전체 동적 전수 조회 (30개, 50개, N개 모두 적용)
    const targetItems = list;
    // 🚨 [버그 수정 - 오늘 3분봉/종목검색과 동일 계열] 이 fetch에 타임아웃이 전혀 없었다 - 이 함수는
    // !isMarketOpen(장마감)일 때 외국인/기관/단타종합 랭킹 요청마다 항상 실행되는데, 청크 하나라도
    // KIS 응답이 지연되면 그 Promise.all이 안 끝나 함수 전체가 hang될 위험이 있었다(오늘 고친 다른
    // 두 사례와 동일 원인). 8초 타임아웃을 추가하고, KIS가 동시 요청에 문제없음을 실측으로 확인했으므로
    // (kisQueue 제거 커밋 참고) 청크 크기를 5→10으로 늘려 50종목 기준 청크 수를 10개→5개로 줄인다
    // (실측: 외국인 랭킹 콜드 9.27초 → 청크 절반으로 대략 그 절반 수준 기대).
    const CHUNK_SIZE = 10;

    for (let i = 0; i < targetItems.length; i += CHUNK_SIZE) {
      const chunk = targetItems.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (item) => {
          let rawSuccess = false;
          // 최대 3회 재시도 (Exponential backoff)
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${item.symbol}`;
              const res = await fetch(url, {
                method: 'GET',
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  authorization: `Bearer ${token}`,
                  appkey: appKey,
                  appsecret: appSecret,
                  tr_id: 'FHKST01010900',
                  custtype: 'P',
                },
                cache: 'no-store',
                signal: AbortSignal.timeout(8000),
              });

              if (!res.ok) {
                throw new Error(`[KIS FHKST01010900 HTTP ${res.status}]`);
              }
              const data = await res.json();
              if (data.rt_cd === '1' || data.msg1?.includes('초당')) {
                throw new Error(`[Rate Limit EGW00201] ${data.msg1 || '초당 거래건수 초과'}`);
              }

              if (data.output && data.output.length > 0) {
                const daysCount = period === '1w' ? 5 : period === '1m' ? 20 : 1;
                const rows = data.output.slice(0, daysCount);

                let rawPbmn = 0;
                let rawQty = 0;

                rows.forEach((row: any) => {
                  if (type === 'foreign') {
                    rawPbmn += parseInt(row.frgn_ntby_tr_pbmn || row.frgn_ntby_amt || '0', 10);
                    rawQty += parseInt(row.frgn_ntby_qty || row.frgn_ntby_vol || '0', 10);
                  } else {
                    rawPbmn += parseInt(row.orgn_ntby_tr_pbmn || row.orgn_ntby_amt || '0', 10);
                    rawQty += parseInt(row.orgn_ntby_qty || row.orgn_ntby_vol || '0', 10);
                  }
                });

                const nowObj = new Date();
                const utcObj = nowObj.getTime() + nowObj.getTimezoneOffset() * 60000;
                const kstObj = new Date(utcObj + 9 * 60 * 60000);
                const hObj = kstObj.getHours();
                const mObj = kstObj.getMinutes();
                const tNumObj = hObj * 100 + mObj;
                const dWeekObj = kstObj.getDay();
                // 🚨 [버그 수정 - 애프터마켓 도입] 위 executeKisForeignInstitutionRankingFetch와 동일한
                // 이유로 15:30 ➔ 20:00.
                const isMarketOpenNow = isKrxMarketOpen(dWeekObj, tNumObj);

                if (!isMarketOpenNow || rawPbmn === 0) {
                  item.asOfDateLabel = getSettledAsOfDateLabel();
                } else {
                  item.asOfDateLabel = `당일 가집계 (${String(hObj).padStart(2, '0')}:${String(mObj).padStart(2, '0')} 기준)`;
                }

                item.netBuyAmt = rawPbmn;
                item.netBuyAmtEok = Number((rawPbmn / 100).toFixed(1));
                item.netBuyQty = rawQty;
                if (item.volume > 0) {
                  item.ratioVsVolume = Number(((Math.abs(rawQty) / item.volume) * 100).toFixed(1));
                }
                rawSuccess = true;
                break;
              }
            } catch (e) {
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 150 * attempt));
              } else {
                console.error(`[enrichRanking Error] ${item.name} (${item.symbol}) 3회 재시도 실패:`, (e as Error).message);
              }
            }
          }
          (item as any)._rawSuccess = rawSuccess;
        })
      );

      if (i + CHUNK_SIZE < targetItems.length) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    // 3회 재시도 후에도 원본 수집에 실패한 종목은 정렬에서 완전 제외 (옵션 a: 잘못된 숫자로 왜곡 방지)
    const validList = list.filter((item) => (item as any)._rawSuccess === true);

    // 전수 원본 조회가 완전 끝난 후 비로소 엄격 정렬
    const isBuy = direction === 'buy';
    validList.sort((a, b) => (isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt));

    validList.forEach((item, idx) => {
      item.rank = idx + 1;
      delete (item as any)._rawSuccess;
    });

    list.length = 0;
    list.push(...validList);
  } catch (err) {
    console.error('[enrichRankingWithRawInvestorData Error]', err);
  }
}



/**
 * 🚨 [버그 수정 - 수칙 1-6: 배지 계산용 트렌드 데이터 단일 소스 통합] 그동안 이 배지("이평선 수렴" 등)를
 * program/foreign·organ/overlap(당일·2일연속) 4곳이 각자 독립적으로 재구현하며 서로 다른 시점·소스의
 * 데이터를 썼다 - 실측: 같은 순간 SK스퀘어가 program에서는 "바닥 반등", overlap/foreign에서는 "이평선
 * 수렴"으로 갈렸고, foreign/organ은 93개 종목 전부가 예외 없이 "이평선 수렴"으로 뭉개져 있었다(그 경로가
 * DB 없이 getCached5dTrend 라이브 예열 캐시에만 의존했는데 그게 비어있었기 때문). 이제 모든 경로가 이
 * 함수 하나로 통일해서 같은 우선순위(1. raw_daily_data DB 20일치 - 재시작/캐시상태 무관 안정적,
 * 2. trendDetailCache 60일 상세, 3. getCached5dTrend 라이브 예열)를 쓰게 한다.
 * DB 조회(fetchRawDailyTrailingDays) 자체는 3분 캐시로 감싸서, 여러 랭킹 API가 짧은 시간 안에 각자
 * 호출해도 Supabase 왕복이 매 요청마다 중복 발생하지 않게 한다.
 *
 * 🚨 [버그 수정 - 수칙 1-6] kisQueue(위 KisRequestQueue.inFlightMap, line 239)가 이미 "동일 id로
 * 진행 중인 요청은 새로 안 만들고 그 Promise를 공유"하는 Single-Flight 패턴을 갖고 있고, 2/3일연속
 * 교집합 쪽도 "완전판 계산이 이미 진행 중이면 중복 실행 안 함"이라는 동일 개념의 가드가 있는데, 처음엔
 * 이걸 재사용하지 않고 값만 저장하는 캐시로 짰다 - 그 결과 콜드스타트처럼 여러 요청이 동시에 몰리면
 * 캐시가 채워지기 전에 각자 따로 Supabase를 두드려 부하가 커지는(실측: upstream timeout 반복) 문제가
 * 있었다. 같은 Single-Flight 개념을 여기도 그대로 적용해 진행 중인 Promise를 공유한다.
 */
const dbTrailingTrendCache = getGlobalMap<string, { data: { dates: string[]; bySymbol: Map<string, Map<string, any>> }; timestamp: number }>('dbTrailingTrendCache');
const dbTrailingTrendInFlight = getGlobalMap<string, Promise<{ dates: string[]; bySymbol: Map<string, Map<string, any>> }>>('dbTrailingTrendInFlight');
const DB_TRAILING_TREND_TTL_MS = 3 * 60 * 1000; // 3분

async function getSharedDbTrailingTrend(): Promise<{ dates: string[]; bySymbol: Map<string, Map<string, any>> }> {
  const key = getKstTodayStr();
  const cached = dbTrailingTrendCache.get(key);
  if (cached && Date.now() - cached.timestamp < DB_TRAILING_TREND_TTL_MS) {
    return cached.data;
  }

  // Single-Flight: 이미 같은 날짜로 진행 중인 조회가 있으면 새로 시작하지 않고 그 Promise를 공유한다.
  const inFlight = dbTrailingTrendInFlight.get(key);
  if (inFlight) return inFlight;

  const fetchPromise = (async () => {
    const { fetchRawDailyTrailingDays } = await import('./supabase');
    // 🚨 [버그 수정] 20일로는 ma60이 항상 null이 되어 "바닥 반등"/60일선 기준 단기과열 배지가 DB 경로에서
    // 절대 안 나오던 근본 원인이었다(차트는 라이브 180일치라 정상 - 실측: SK스퀘어 program/overlap
    // "이평선 수렴" ↔ 차트 "바닥 반등" 불일치). ma60 계산 최소 요건(60일)보다 여유있게 90일로 늘린다.
    const data = await fetchRawDailyTrailingDays(key, 90).catch(() => ({ dates: [] as string[], bySymbol: new Map<string, Map<string, any>>() }));
    dbTrailingTrendCache.set(key, { data, timestamp: Date.now() });
    return data;
  })();

  dbTrailingTrendInFlight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    dbTrailingTrendInFlight.delete(key);
  }
}

export async function resolveTrendForBadge(
  symbol: string,
  todaySnapshot: { currentPrice: number; change?: number; changeRate: number; volume: number }
): Promise<InvestorTrendDay[]> {
  const { dates: dbDates, bySymbol: dbBySymbol } = await getSharedDbTrailingTrend();
  const symbolDbDates = dbBySymbol.get(symbol);
  if (symbolDbDates && symbolDbDates.size > 0) {
    const dbTrend: InvestorTrendDay[] = dbDates
      .filter((d) => symbolDbDates.has(d))
      .map((d) => {
        const row: any = symbolDbDates.get(d)!;
        return {
          date: d,
          closePrice: row.close_price || 0,
          openPrice: row.open_price || 0,
          highPrice: row.high_price || 0,
          lowPrice: row.low_price || 0,
          volume: row.volume || 0,
          changeRate: row.change_rate || 0,
        } as InvestorTrendDay;
      });
    // 🚨 [버그 수정] 장마감 후엔 todaySnapshot.currentPrice가 "오늘의 새 시세"가 아니라 DB에 이미 저장된
    // 최신 확정일(예: 9/4)의 마감가 그대로다 - 그런데 무조건 "오늘"이라는 새 항목으로 추가해버려서 같은
    // 값이 이틀치처럼 중복됐다. 91개(중복 포함) 기준 slice(-60)이 진짜 60일 중 가장 오래된 1일을 밀어내고
    // 대신 중복값을 넣어 disparate60이 89.9%→90.6%로 미세하게 바뀌며 "바닥 반등" 판정을 근소하게
    // 놓쳤다(실측: 리노공업 058470 - 차트 disparate60=89.9% vs 이 버그로 랭킹 90.6%). DB의 마지막
    // 종가와 오늘 스냅샷 가격이 같으면(=이미 반영된 같은 거래일) 중복 추가하지 않는다.
    const lastDbClose = dbTrend.length > 0 ? dbTrend[dbTrend.length - 1].closePrice : 0;
    const isAlreadyReflected = lastDbClose > 0 && lastDbClose === todaySnapshot.currentPrice;
    if (!isAlreadyReflected) {
      dbTrend.push({
        date: 'today',
        closePrice: todaySnapshot.currentPrice,
        priceChange: todaySnapshot.change || 0,
        changeRate: todaySnapshot.changeRate,
        volume: todaySnapshot.volume,
      } as InvestorTrendDay);
    }
    if (dbTrend.filter((d) => d.closePrice > 0).length > 0) {
      return dbTrend;
    }
  }

  // 2/3순위 폴백: DB 이력이 아직 없는 신규상장 등 - 가짜로 채우지 않고 있는 캐시만 사용(수칙 1-3)
  const fullCacheKey = `${symbol}-60d-v60d-full`;
  const fullCached: InvestorTrendResponse | null | undefined = trendDetailCache.get(fullCacheKey)?.data;
  if (fullCached && fullCached.trend && fullCached.trend.length > 0) return fullCached.trend;

  const { getCached5dTrend } = await import('./batchCollector');
  const trendRes = getCached5dTrend(symbol);
  return trendRes?.trend || [];
}

export function computeStatusBadgeFromTrend(trend: InvestorTrendDay[]): { shortBadge: string; badgeStyle: string } {
  const rawItems = (trend || []).filter((d) => d.closePrice && d.closePrice > 0);
  const rawCloses = rawItems.map((d) => d.closePrice);
  // 액면분할/감자 등으로 옛 가격 스케일이 섞인 구간은 이동평균 계산에서 제외 (수칙 1-3: 가짜 보정 금지, 오염 구간 제외 방식)
  const items = rawItems.slice(findSplitSafeStartIndex(rawCloses));
  const closes = items.map((d) => d.closePrice);
  if (closes.length === 0) {
    return {
      shortBadge: '⚪ 이평선 수렴',
      badgeStyle: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700',
    };
  }

  const currentP = closes[closes.length - 1];
  const ma5 = closes.length >= 5 ? closes.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60 : null;
  const volumeRatio = computeRecentVolumeRatio(items.map((d) => d.volume));

  return computeUnifiedStatusBadge(currentP, ma5, ma20, ma60, volumeRatio);
}

const overlapMemoryCache = getGlobalMap<string, { data: InvestorRankingResponse; timestamp: number }>('overlapMemoryCache');
const OVERLAP_CACHE_TTL_MS = 5 * 60 * 1000; // 5분 (2일/3일 연속 탭 캐시 히트 보장)

/**
 * 외국인, 기관, 프로그램 3개 수급 랭킹의 교집합(중복 수급 종목) 추출 및 정렬
 */
export async function fetchOverlapRankingData(
  direction: RankingDirection = 'buy',
  period: RankingPeriod = '1d',
  minOverlap: number = 2,
  topLimit: number = 50,
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  const masterCacheKey = `v3_master_${direction}_${period}_${minOverlap}_${market}`;
  let masterData: InvestorRankingResponse | null = null;
  const dynamicTtl = getDynamicRankingTtl();

  const cached = overlapMemoryCache.get(masterCacheKey);
  if (cached && cached.data && Array.isArray(cached.data.list) && cached.data.list.length > 0 && Date.now() - cached.timestamp < dynamicTtl) {
    masterData = cached.data;
  }

  // 🚨 [재시도 - 근본 원인 3가지가 그 사이 해소됨] 예전에 이 자리에 Supabase 읽기를 넣었다가
  // (1) 매 재계산 자체가 콜드스타트 타이밍마다 결과가 달라져 효과가 없었고 (2) 서버가 완전히 응답
  // 불가(hang) 상태에 빠지는 사고가 있었고 (3, 1차 재시도에서 새로 발견) 뱃지 요약 전용 경량 캐시를
  // "완전한 리스트"로 오인해 읽어 name/isCreditAvailable 등 핵심 필드가 통째로 undefined가 되는
  // 회귀를 만들었다. (1)은 fetchKisProgramTrade kisQueue 직렬화로, (2)는 Supabase 클라이언트에
  // 8초 타임아웃 추가로, (3)은 완전히 별도의 cache_key('full:' 접두사, 아래 executeAsyncOverlapCalculation
  // 안에서 저장)로 각각 해소됐다 - program 배치(batchCollector.ts)에서 이미 재검증 완료
  // (21대 검증 + 골든 스냅샷 모두 PASS, 필드 누락 0건 확인)했으므로 동일 패턴을 여기도 적용한다.
  // 🚨 [버그 수정 - 수칙 1-6] maxAgeMs를 24시간 고정값으로 뒀었다 - 위 인메모리 캐시(line 2444)는
  // "다음 영업일 08:30까지"를 날짜 경계까지 계산하는 dynamicTtl을 쓰는데, 여기 Supabase 캐시는 그냥
  // 시계로 24시간만 셌다. 그 결과 장마감 후(예: 전날 20:45)에 저장된 캐시가 "아직 24시간 안 지났다"는
  // 이유만으로 다음날 09:00~15:30 장이 통째로 열렸다 닫혀도 계속 "신선하다"고 오판되어, 어제 저녁
  // 시점의 현재가/등락률/추세배지(statusBadge)가 오늘 하루 종일 그대로 나가는 회귀가 있었다(실측:
  // 삼성E&A 028050 - 차트는 9/9 종가 50800원 기준 "단기과열"인데 당일교집합/3일연속 탭은 9/8 종가
  // 49150원이 "(9/9 기준)"이라고 잘못 라벨된 채 "정배열"로 나옴 - Supabase 조회 결과 해당 캐시가
  // 20.6시간 전인 9/8 20:45에 쓰인 뒤 한 번도 재계산 안 됐음을 확인). 처음엔 인메모리와 똑같이
  // dynamicTtl(duration)을 그대로 재사용했는데, 그러자 이번엔 "오늘 장중 10:02에 기록된 스냅샷이
  // 장마감 후에도 duration이 안 지났다는 이유로 계속 신선하다고 오판"되는 2차 회귀가 실측으로 확인됐다
  // (삼성E&A 028050 - 3일연속 탭이 10:02 스냅샷 가격 49150원을 17시대까지 그대로 씀, 실제 종가는
  // 50800원). duration이 아니라 "가장 최근 마감(15:30) 이후에 기록됐는가"를 보는
  // getSharedCacheMaxAgeMs()로 교체한다 - 위 getDynamicRankingTtl() 바로 아래 정의, 수칙 1-6.
  if (!masterData) {
    const sharedMap = await fetchSharedRankCacheBatch([`full:${masterCacheKey}`], getSharedCacheMaxAgeMs()).catch(() => new Map<string, any[]>());
    const sharedList = sharedMap.get(`full:${masterCacheKey}`);
    if (sharedList && sharedList.length > 0) {
      console.log(`[Shared Rank Cache Hit] full:${masterCacheKey} - 다른 인스턴스가 이미 계산해둔 당일교집합 결과를 Supabase에서 재사용`);
      masterData = {
        type: 'overlap',
        direction,
        period,
        list: sharedList,
        isMock: false,
        // 🚨 [버그 수정 - 애프터마켓 진단 중 발견] 이 콜드스타트 폴백 경로는 최상위 asOfDateLabel을
        // 아예 안 채우고 있었다(undefined) - 프론트가 data?.list?.[0]?.asOfDateLabel로 폴백해서
        // 화면엔 문제가 없었지만, 이미 sharedList 각 항목에 정확한 라벨이 들어있으니 그대로 재사용한다.
        asOfDateLabel: sharedList[0]?.asOfDateLabel,
        updatedAt: new Date().toISOString(),
      };
      overlapMemoryCache.set(masterCacheKey, { data: masterData, timestamp: Date.now() });
    } else {
      masterData = await executeAsyncOverlapCalculation(direction, period, minOverlap, market, masterCacheKey);
    }
  }

  let list = masterData.list || [];
  if (market === 'KOSPI') {
    list = list.filter((item) => resolveMarketType(item.symbol) === 'KOSPI');
  } else if (market === 'KOSDAQ') {
    list = list.filter((item) => resolveMarketType(item.symbol) === 'KOSDAQ');
  }

  if (topLimit && topLimit > 0) {
    list = list.slice(0, topLimit);
  }

  const finalRes: InvestorRankingResponse = {
    ...masterData,
    list,
  };

  assertNoMockLeak(finalRes);
  return finalRes;
}

/**
 * 수급교집합(당일/2일연속/3일연속) 탭 공통 "별표 추천(AI Pick)" 추세 배수 산출 함수 (Single Source of Truth)
 * 단타 트레이더 관점 반영: 다일 추세 구조(정배열/바닥반등)의 지배력은 소폭 낮추고,
 * 단기과열을 세력매집(모멘텀 지속 기대)과 설거지주의(상투 리스크)로 명확히 차등 배점한다.
 *
 * ⚠️ 과거 버전은 '단기 과열'(공백 포함)로 매칭해 실제 배지 텍스트 '단기과열'(공백 없음)과
 *    끝내 일치하지 않아 이 분기가 단 한 번도 발동하지 않는 버그가 있었다(항상 기본값 1.0 적용).
 */
function getOverlapTrendMultiplier(statusBadge?: string): number {
  if (statusBadge?.includes('정배열')) return 1.3;                                    // 정배열 상승 추세
  if (statusBadge?.includes('바닥 반등')) return 1.3;                                  // 바닥 반등 타점
  if (statusBadge?.includes('단기과열') && statusBadge?.includes('세력매집')) return 1.1;  // 단기과열이나 구조 유지 - 모멘텀 지속 기대
  if (statusBadge?.includes('이평선 수렴')) return 1.0;                                 // 에너지 축적/관망
  if (statusBadge?.includes('역배열')) return 0.7;                                    // 하락 추세
  if (statusBadge?.includes('단기과열') && statusBadge?.includes('설거지주의')) return 0.5;  // 구조 붕괴 + 거래량 폭증 - 상투/매물출회 리스크
  return 1.0;
}

/**
 * 수급교집합 탭 공통 "별표 추천(AI Pick)" 점수 산출 함수 (Single Source of Truth)
 * 단타 트레이더 관점으로 튜닝: 당일 거래회전율(ratioScore) 비중을 확대하고,
 * 등락률 페널티(candleScore)를 하락폭에 비례하도록 대칭화했다(기존: 하락이면 등락폭 무관 -15 고정).
 */
function computeOverlapAiPickScore(item: {
  overlapCount?: number;
  netBuyAmtEok?: number;
  ratioVsVolume?: number;
  changeRate: number;
  statusBadge?: string;
}): number {
  const overlapScore = (item.overlapCount || 2) * 100;
  const logAmtScore = Math.log(Math.max(0, item.netBuyAmtEok || 0) + 1) * 20;
  // 단타는 유동성/회전율이 핵심이라 상한을 30→40으로 확대(계수 1.5→1.8)
  const ratioScore = Math.min((item.ratioVsVolume || 0) * 1.8, 40);
  // 상승/하락 대칭 처리: 등락폭에 비례해 ±25점 캡 (기존 하락 고정 -15 페널티 제거)
  const candleScore = Math.max(-25, Math.min((item.changeRate || 0) * 2.5, 25));

  const rawScore = overlapScore + logAmtScore + ratioScore + candleScore;
  const trendMult = getOverlapTrendMultiplier(item.statusBadge);
  return rawScore * trendMult;
}

/**
 * 프론트엔드 "진입가능만" 필터와 동일한 기준: 이격도 배지가 단기과열(세력매집/설거지주의 불문) 또는
 * 역배열이면 false를 반환한다. AI픽(별표) 후보군 선정에서 재사용해 "별표=진입가능 종목 중 최우선"이
 * 실제로 성립하도록 한다.
 * - 단기과열: 추세는 우호적이지만 원본 수급강도(overlapScore 등)가 커서 배율 가산(1.1배)을 받아도
 *   여전히 1위까지 올라갈 수 있었기 때문에, 배율 조정이 아니라 후보군 자체에서 배제한다.
 * - 역배열: 이평선 배열 자체가 하락 추세라 "N일 연속 매수"가 바닥 매집인지 단순 반등인지 구분이 안 되고,
 *   실측 사례(HD현대 267250, 당일 -4.34% 하락 중에도 2일연속 매수라는 이유로 5위 별표)로 확인된
 *   근본적으로 다른 리스크라 단기과열과 같은 기준으로 후보군에서 제외한다.
 */
function isEntryReadyBadge(statusBadge?: string): boolean {
  const badge = statusBadge || '';
  return !badge.includes('단기과열') && !badge.includes('역배열');
}

/**
 * 비동기 백그라운드 수급 교집합 데이터 계산 헬퍼
 */
async function executeAsyncOverlapCalculation(
  direction: RankingDirection,
  period: RankingPeriod,
  minOverlap: number,
  market: MarketType,
  masterCacheKey: string
): Promise<InvestorRankingResponse> {
  try {
    const { getBatchRankingData, getBatchRankingDataAsync, getCached5dTrend, getBatchTrend5d } = await import('./batchCollector');
    const candidateLimit = 50;

    const reqPeriod = (period === 'consecutive2d' || period === 'consecutive3d') ? '1d' : (period as '1d' | '1w' | '1m');
    const [foreignRes, organRes, programRes] = await Promise.all([
      fetchKisForeignInstitutionRanking('foreign', direction, reqPeriod, market, candidateLimit),
      fetchKisForeignInstitutionRanking('organ', direction, reqPeriod, market, candidateLimit),
      getBatchRankingDataAsync('program', direction, reqPeriod, market, candidateLimit),
    ]);

    const map = new Map<
      string,
      {
        symbol: string;
        name: string;
        currentPrice: number;
        change: number;
        changeRate: number;
        volume: number;
        ranksByType: OverlapInvestorRank[];
      }
    >();
    // 🚨 [버그 수정] resolveStockPriceAndChange가 콜드스타트 등으로 runtimePriceCache 미등록 상태라
    // fallback(basePrice) 값을 돌려준 종목들을 별도로 추적한다 - 이런 종목이 하나라도 섞인 결과를
    // 그대로 마스터 캐시에 저장하면, 장마감 후엔 "다음날 개장 전까지 사실상 영구 캐시" 정책 때문에
    // 오염된 스냅샷이 하루 종일 고정되는 문제로 이어진다(실측 확인됨). 아래에서 캐시 저장 여부를
    // 이 Set으로 판단한다.
    const fallbackPricedSymbols = new Set<string>();

    const isBuy = direction === 'buy';

    const addList = (
      res: InvestorRankingResponse,
      type: 'foreign' | 'organ' | 'program',
      label: string
    ) => {
      const topList = (res.list || [])
        .filter((item) => (isBuy ? item.netBuyAmt > 0 : item.netBuyAmt < 0))
        .slice(0, 50);

      topList.forEach((item, idx) => {
        if (!map.has(item.symbol)) {
          const priceInfo = resolveStockPriceAndChange(item.symbol, item.currentPrice, item.change, item.changeRate);
          // 🚨 [버그 수정 - 정밀화] 처음엔 "runtimePriceCache 미등록 = fallback"으로 단순 판정해서
          // 이 종목을 이번 계산에서 통째로 제외했는데, 이게 너무 거칠었다 - item.currentPrice(외국인/
          // 기관/프로그램 랭킹 API가 이미 준 값) 자체는 이미 정상 실시간 값인 경우가 많은데도, 단지
          // runtimePriceCache에 아직 없다는 이유만으로 멀쩡한 종목까지 통째로 걸러내 버려서(실측: 순수
          // 당일교집합 쿼리가 0개를 반환하는 과도한 부작용 발견) 오히려 데이터가 더 사라지는 회귀를
          // 만들었다. 진짜 fallback인지는 "그 값이 stockUniverse300의 하드코딩된 basePrice와 정확히
          // 일치하는지"로만 판정한다 - 실제 KIS 실시간가가 basePrice와 우연히 정확히 일치할 확률은
          // 사실상 0이므로, 이 조건이 참일 때만 "진짜 더미값"으로 신뢰하고 제외한다.
          const basePriceEntry = TOP_300_STOCKS.find((s) => s.symbol === item.symbol);
          const isSuspectedDummy = priceInfo.isFallback && !!basePriceEntry && priceInfo.currentPrice === basePriceEntry.basePrice;
          if (isSuspectedDummy) {
            fallbackPricedSymbols.add(item.symbol);
            return;
          }
          map.set(item.symbol, {
            symbol: item.symbol,
            name: item.name,
            currentPrice: priceInfo.currentPrice,
            change: priceInfo.change,
            changeRate: priceInfo.changeRate,
            volume: item.volume,
            ranksByType: [],
          });
        }
        const entry = map.get(item.symbol);
        if (!entry) return; // 위에서 fallback 가격으로 제외된 종목 - ranksByType도 함께 건너뛴다
        entry.ranksByType.push({
          type,
          label,
          rank: item.rank || (idx + 1),
          isRanked: true,
          netBuyAmt: item.netBuyAmt,
          netBuyAmtEok: item.netBuyAmtEok,
          asOfDateLabel: item.asOfDateLabel,
        });
      });
    };

    addList(foreignRes, 'foreign', '외국인');
    addList(organRes, 'organ', '기관');
    addList(programRes, 'program', '프로그램');

    // 🚨 [버그 수정 - 당일교집합 후보 수집 불안정성 근본 원인] 위 3개 addList()가 채우는 map은 오직
    // 그 순간의 라이브 상위 50위 스냅샷(외국인/기관 KIS 랭킹 TR, 프로그램 배치 top-50)에만 의존한다.
    // 이 세 스냅샷 어디에도 없던 종목은 실제로 오늘 2개 이상 주체가 순매수 중이었어도 통째로 후보에서
    // 빠지고, 이 top-50 자체가 호출 시점(콜드스타트 재시작 포함)마다 달라져 "몇 개 종목이 잡히는지"가
    // 실제 시장 움직임과 무관하게 매 계산마다 흔들렸다(실측: 재시작 2회 연속 조회에도 7개→15개로 변동
    // - 위 2285번 줄 [시도했다가 되돌림] 주석 참고). fetchConsecutiveNDaysOverlapRankingData(2/3일연속)
    // 는 이미 TOP_300_STOCKS 전체를 캐시 기반(universeExtra, 3378번 줄)으로 훑어 이 문제를 풀어놨다 -
    // 동일 패턴을 여기 재사용한다. 신규 라이브 KIS 호출은 전혀 만들지 않는다(캐시 미보유 종목은 그냥
    // 건너뜀 - fail-open, 2/3일연속과 동일 원칙). 이렇게 map만 넓혀두면 바로 아래(entries 순회) 기존
    // "50위 랭킹 풀에 없더라도 실제 당일 순매수한 주체를 트렌드 실데이터에서 전수 동기화" 루프가
    // 그대로 이 종목들의 ranksByType/overlapCount를 판정한다 - 새 판정 로직은 추가하지 않는다.
    const overlapUniverseCovered = new Set(map.keys());
    const overlapUniverseExtra = TOP_300_STOCKS.filter(
      (s) => !overlapUniverseCovered.has(s.symbol) && (market === 'ALL' || s.market === market)
    );
    overlapUniverseExtra.forEach((s) => {
      const trendRes = trendDetailCache.get(s.symbol)?.data || getCached5dTrend(s.symbol) || getBatchTrend5d(s.symbol);
      if (!trendRes || !Array.isArray(trendRes.trend) || trendRes.trend.length === 0) return; // 캐시 미보유 - 라이브 호출 없이 스킵

      const info = trendRes.stockInfo;
      const priceInfo = resolveStockPriceAndChange(s.symbol, info?.currentPrice ?? 0, info?.change ?? 0, info?.changeRate ?? 0);
      // addList()와 동일한 fallback 더미가격 판정(2436번 줄) - 오염된 값이 map에 섞여 캐시되는 걸 막는다.
      const isSuspectedDummy = priceInfo.isFallback && priceInfo.currentPrice === s.basePrice;
      if (isSuspectedDummy) {
        fallbackPricedSymbols.add(s.symbol);
        return;
      }

      map.set(s.symbol, {
        symbol: s.symbol,
        name: getStockName(s.symbol, info?.name),
        currentPrice: priceInfo.currentPrice,
        change: priceInfo.change,
        changeRate: priceInfo.changeRate,
        volume: info?.volume ?? trendRes.trend[trendRes.trend.length - 1]?.volume ?? 0,
        ranksByType: [],
      });
    });

    // 50위 랭킹 풀에 없더라도 실제 당일 순매수한 주체를 트렌드 실데이터에서 전수 동기화
    const overlapItems: RankingItem[] = [];
    const ALL_ENTITIES: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }> = [
      { type: 'foreign', label: '외국인' },
      { type: 'organ', label: '기관' },
      { type: 'program', label: '프로그램' },
    ];

    const entries = Array.from(map.values());

    for (const value of entries) {
      // 0ms 순수 메모리 캐시 조회 (실시간 네트워크 TR 난사 원천 차단)
      const trendRes = trendDetailCache.get(value.symbol)?.data || getCached5dTrend(value.symbol) || getBatchTrend5d(value.symbol);
      const latestDay = trendRes?.trend && trendRes.trend.length > 0 ? trendRes.trend[trendRes.trend.length - 1] : null;

      // 랭킹 50위 밖이라도 당일 실제 순매수한 주체를 ranksByType에 보강
      if (latestDay || trendRes?.summary) {
        // 외국인
        const foreignAmt = (latestDay?.foreignNetBuyAmt || 0) > 0 ? latestDay.foreignNetBuyAmt : (trendRes?.summary?.foreign?.todayEstimateAmt || 0);
        if (!value.ranksByType.some((r) => r.type === 'foreign') && foreignAmt > 0) {
          value.ranksByType.push({
            type: 'foreign',
            label: '외국인',
            rank: 0,
            isRanked: false,
            netBuyAmt: foreignAmt,
            netBuyAmtEok: Number((foreignAmt / 100).toFixed(1)),
            asOfDateLabel: latestDay?.date ? `(${latestDay.date.slice(4, 6)}/${latestDay.date.slice(6, 8)} 기준)` : '(당일)',
          });
        }
        // 기관
        const organAmt = (latestDay?.organNetBuyAmt || 0) > 0 ? latestDay.organNetBuyAmt : (trendRes?.summary?.organ?.todayEstimateAmt || 0);
        if (!value.ranksByType.some((r) => r.type === 'organ') && organAmt > 0) {
          value.ranksByType.push({
            type: 'organ',
            label: '기관',
            rank: 0,
            isRanked: false,
            netBuyAmt: organAmt,
            netBuyAmtEok: Number((organAmt / 100).toFixed(1)),
            asOfDateLabel: latestDay?.date ? `(${latestDay.date.slice(4, 6)}/${latestDay.date.slice(6, 8)} 기준)` : '(당일)',
          });
        }
      }

      // 프로그램 (실제 실데이터 TR 확인)
      const pt = trendRes?.programTrade;
      if (!value.ranksByType.some((r) => r.type === 'program') && pt && pt.totalNetBuyAmt > 0) {
        value.ranksByType.push({
          type: 'program',
          label: '프로그램',
          rank: 0,
          isRanked: false,
          netBuyAmt: pt.totalNetBuyAmt,
          netBuyAmtEok: Number((pt.totalNetBuyAmt / 100).toFixed(1)),
          asOfDateLabel: pt.asOfDateLabel || '(당일)',
        });
      }

      const overlapCount = value.ranksByType.length;

      // 수급 교집합: 3대 주체 중 minOverlap 이상 순매수한 종목 포함
      if (overlapCount >= minOverlap) {
        const investorLabels = value.ranksByType.map((r) => r.label);
        const totalNetBuyAmt = value.ranksByType.reduce((sum, r) => sum + r.netBuyAmt, 0);
        const totalNetBuyAmtEok = Number((totalNetBuyAmt / 100).toFixed(1));
        const investorBadge = `${overlapCount}개 주체 중복 (${investorLabels.join(' · ')})`;
        const priceInfo = resolveStockPriceAndChange(value.symbol, value.currentPrice, value.change, value.changeRate);
        const totalNetBuyQty = Math.round(
          value.ranksByType.reduce((sum, r) => {
            const qty = priceInfo.currentPrice > 0 ? Math.round((r.netBuyAmt * 1000000) / priceInfo.currentPrice) : 0;
            return sum + qty;
          }, 0)
        );

        const missingEntities = ALL_ENTITIES.filter((e) => !value.ranksByType.some((r) => r.type === e.type));

        overlapItems.push({
          rank: 0,
          symbol: value.symbol,
          name: value.name,
          currentPrice: priceInfo.currentPrice,
          change: priceInfo.change,
          changeRate: priceInfo.changeRate,
          netBuyQty: totalNetBuyQty,
          netBuyAmt: totalNetBuyAmt,
          netBuyAmtEok: totalNetBuyAmtEok,
          volume: value.volume,
          ratioVsVolume: value.volume > 0 ? Number(((Math.abs(totalNetBuyQty) / value.volume) * 100).toFixed(1)) : 0,
          foreignNetBuyAmt: value.ranksByType.find((r) => r.type === 'foreign')?.netBuyAmt,
          organNetBuyAmt: value.ranksByType.find((r) => r.type === 'organ')?.netBuyAmt,
          programNetBuyAmt: value.ranksByType.find((r) => r.type === 'program')?.netBuyAmt,
          overlapCount,
          investorBadge,
          ranksByType: value.ranksByType,
          missingEntities,
        });
      }
    }

    overlapItems.sort((a, b) => {
      if (Math.abs(b.netBuyAmt - a.netBuyAmt) > 0.01) {
        return isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
      }
      return (b.overlapCount || 0) - (a.overlapCount || 0);
    });

    // 🚨 [버그 수정 - 수칙 1-6: program/foreign·organ과 동일한 resolveTrendForBadge로 통일] 당일교집합만
    // 독자적인 DB 조회 로직을 따로 갖고 있었다 - 이제 foreign/organ도 쓰는 공용 함수 하나로 합쳐서
    // 세 경로가 완전히 같은 데이터·우선순위로 배지를 계산하게 한다(실측: 로보티즈 108490이 당일교집합=
    // 이평선수렴, 2일연속=단기과열(설거지주의)로 같은 순간에 달랐던 문제, foreign/organ 93종목 전부
    // "이평선 수렴"으로 뭉개졌던 문제 - 둘 다 이 통합으로 해결).
    const finalOverlapItems = await Promise.all(overlapItems.map(async (item, index) => {
      // 아래쪽(foreignAmt/organAmt/programAmt 순위밖 보정)이 trendRes.summary/programTrade(트렌드
      // 배열이 아닌 원본 요약 필드)를 참조하므로 별도로 계속 조회해둔다(0ms 인메모리 조회, 비용 없음).
      const trendRes = getCached5dTrend(item.symbol);
      const trendData = await resolveTrendForBadge(item.symbol, {
        currentPrice: item.currentPrice,
        change: item.change,
        changeRate: item.changeRate,
        volume: item.volume,
      });

      const latestTrend = trendData.length > 0 ? trendData[trendData.length - 1] : null;
      const statusInfo = trendData.length > 0
        ? computeStatusBadgeFromTrend(trendData)
        : computeUnifiedStatusBadge(item.currentPrice, null, null, null);

      const ranksByType = [...(item.ranksByType || [])];

      // 1. 외국인 실매수 순위밖 보정
      const foreignAmt = latestTrend?.foreignNetBuyAmt || trendRes?.summary?.foreign?.todayEstimateAmt || 0;
      if ((isBuy ? foreignAmt > 0 : foreignAmt < 0) && !ranksByType.some((r) => r.type === 'foreign')) {
        ranksByType.push({
          type: 'foreign',
          label: '외국인',
          rank: 0,
          isRanked: false,
          netBuyAmt: foreignAmt,
          netBuyAmtEok: Number((foreignAmt / 100).toFixed(1)),
          asOfDateLabel: '당일 가집계',
        });
      }

      // 2. 기관 실매수 순위밖 보정
      const organAmt = latestTrend?.organNetBuyAmt || trendRes?.summary?.organ?.todayEstimateAmt || 0;
      if ((isBuy ? organAmt > 0 : organAmt < 0) && !ranksByType.some((r) => r.type === 'organ')) {
        ranksByType.push({
          type: 'organ',
          label: '기관',
          rank: 0,
          isRanked: false,
          netBuyAmt: organAmt,
          netBuyAmtEok: Number((organAmt / 100).toFixed(1)),
          asOfDateLabel: '당일 가집계',
        });
      }

      // 3. 프로그램 실매수 순위밖 보정
      const programAmt = trendRes?.programTrade?.totalNetBuyAmt || 0;
      if ((isBuy ? programAmt > 0 : programAmt < 0) && !ranksByType.some((r) => r.type === 'program')) {
        ranksByType.push({
          type: 'program',
          label: '프로그램',
          rank: 0,
          isRanked: false,
          netBuyAmt: programAmt,
          netBuyAmtEok: Number((programAmt / 100).toFixed(1)),
          asOfDateLabel: trendRes?.programTrade?.asOfDateLabel || getSettledAsOfDateLabel(),
        });
      }

      const ENTITY_ORDER: Record<string, number> = { foreign: 1, organ: 2, program: 3 };
      ranksByType.sort((a, b) => (ENTITY_ORDER[a.type] || 99) - (ENTITY_ORDER[b.type] || 99));

      const overlapCount = ranksByType.length;
      const totalNetBuyAmt = ranksByType.reduce((sum, r) => sum + r.netBuyAmt, 0);
      const totalNetBuyAmtEok = Number((totalNetBuyAmt / 100).toFixed(1));
      const price = item.currentPrice > 0 ? item.currentPrice : (latestTrend?.closePrice || 0);
      const totalNetBuyQty = price > 0 ? Math.round((totalNetBuyAmt * 1000000) / price) : 0;

      const ALL_ENTITIES: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }> = [
        { type: 'foreign', label: '외국인' },
        { type: 'organ', label: '기관' },
        { type: 'program', label: '프로그램' },
      ];
      const missingEntities = ALL_ENTITIES.filter((e) => !ranksByType.some((r) => r.type === e.type));

      return {
        ...item,
        rank: index + 1,
        overlapCount,
        ranksByType,
        missingEntities,
        netBuyAmt: totalNetBuyAmt,
        netBuyAmtEok: totalNetBuyAmtEok,
        netBuyQty: totalNetBuyQty,
        foreignNetBuyAmt: ranksByType.find((r) => r.type === 'foreign')?.netBuyAmt,
        organNetBuyAmt: ranksByType.find((r) => r.type === 'organ')?.netBuyAmt,
        programNetBuyAmt: ranksByType.find((r) => r.type === 'program')?.netBuyAmt,
        // 🚨 [버그 수정 - 사용자 지적: "그 전에는 애프터마켓이 없었어서... 애프터마켓까지 살아있게
        // 고치는게 맞지않을까?" 확인 도중 발견] 시간과 무관하게 항상 getSettledAsOfDateLabel()로
        // 박아뒀던 게 원인 - 개별 ranksByType[].asOfDateLabel은 이미 애프터마켓까지 실시간인데, 이
        // 요약 라벨만 항상 "정산 완료"처럼 보여서 프론트가 "전 주체 종가 정산 완료"로 오판했다.
        asOfDateLabel: getLiveOrSettledAsOfLabel(),
        statusBadge: statusInfo.shortBadge,
        statusBadgeStyle: statusInfo.badgeStyle,
      };
    }));

    // 3대 주체 전수 합산 후 최종 정렬: 1. overlapCount 내림차순, 2. totalNetBuyAmt 내림차순
    finalOverlapItems.sort((a, b) => {
      const countA = a.overlapCount || 0;
      const countB = b.overlapCount || 0;
      if (countB !== countA) return countB - countA;
      return isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
    });

    finalOverlapItems.forEach((item, idx) => {
      item.rank = idx + 1;
    });

    const aiPickCandidates = [...finalOverlapItems]
      .filter((item) => isEntryReadyBadge(item.statusBadge)) // 단기과열 종목은 별표(AI픽) 후보군에서 제외
      .filter((item) => !isEtfSymbol(item.symbol, item.name)) // 레버리지/인버스 등 ETF·ETN은 개별 종목 추천 취지에 안 맞아 AI픽 후보군에서 제외 (사용자 요청: "레버리지관련 종목은 다 빼서 추천")
      .map((item) => ({
        symbol: item.symbol,
        score: computeOverlapAiPickScore(item),
      }))
      .sort((a, b) => b.score - a.score);

    const top5Symbols = aiPickCandidates.slice(0, 5).map((c) => c.symbol);

    finalOverlapItems.forEach((item) => {
      const pickIdx = top5Symbols.indexOf(item.symbol);
      item.aiPickRank = pickIdx >= 0 ? pickIdx + 1 : undefined;
    });

    const mergedList = await mergeCreditStatusToRanking(finalOverlapItems);

    // 당일교집합(period === '1d')에 한해 "오늘 이 종목이 언제 처음 교집합 명단에 포착됐는지" 표시를 붙인다.
    // Supabase에 기록이 없는(오늘 처음 보는) 종목만 INSERT하고(ignoreDuplicates), 이미 기록된 종목은
    // 절대 덮어쓰지 않는다 - 그래야 장중 여러 번 재계산돼도 "최초" 시각이 유지된다.
    if (period === '1d' && mergedList.length > 0) {
      try {
        const todayStr = getKstTodayStr();
        const firstSeenMap = await fetchDailyOverlapFirstSeen(todayStr, direction);
        const nowIso = new Date().toISOString();
        mergedList.forEach((item) => {
          const seenAt = firstSeenMap[item.symbol] || nowIso; // 오늘 처음 보는 종목은 지금 이 순간이 곧 최초 포착 시각
          item.firstSeenAt = seenAt;
          item.firstSeenLabel = formatKstFirstSeenLabel(seenAt);
        });
        // 응답 지연 없이 백그라운드로 신규 종목만 기록(await 하지 않음 - 실패해도 화면 표시엔 지장 없음)
        insertDailyOverlapFirstSeenIfMissing(
          todayStr,
          direction,
          mergedList.map((item) => ({ symbol: item.symbol, name: item.name }))
        ).catch((e) => console.warn('[Daily Overlap First-Seen Insert Skip]', e?.message || e));
      } catch (e: any) {
        console.warn('[Daily Overlap First-Seen Enrich Skip]', e?.message || e);
      }
    }

    const masterData: InvestorRankingResponse = {
      type: 'overlap',
      direction,
      period,
      list: mergedList,
      isMock: foreignRes.isMock || programRes.isMock,
      lastBatchTime: programRes.lastBatchTime || foreignRes.lastBatchTime,
      asOfDateLabel: foreignRes.asOfDateLabel || getSettledAsOfDateLabel(),
      updatedAt: new Date().toISOString(),
    };

    // 🚨 [버그 수정] 결과에 fallback 가격(콜드스타트로 runtimePriceCache 미등록)이 섞여 있으면 캐시에
    // 저장하지 않는다 - 저장해버리면 장마감 후 "다음날 개장 전까지 사실상 영구" 캐시 정책 때문에 이
    // 오염이 하루 종일 고정된다(실측: SK이노베이션 등 여러 종목이 배지 계산 불가 상태로 고정됐었음).
    // 저장을 건너뛰어도 이번 응답 자체는 그대로 반환하고(fail-open), 다음 요청 때 재계산을 다시
    // 시도해 실시간 가격이 채워지면(runtimePriceCache 등록) 그제서야 정상적으로 캐시된다.
    const hasFallbackContamination = masterData.list.some((item) => fallbackPricedSymbols.has(item.symbol));
    // 🚨 [버그 수정 - 근본 원인] runTop50BatchCollector에 returnEarly 백그라운드 완성 패턴을 도입한 뒤,
    // 콜드스타트 직후 programRes(getBatchRankingDataAsync)가 우선순위 40종목만 채워진 부분판
    // (isPartial:true)을 반환하는 구간이 생겼다 - 그 순간 당일교집합을 계산하면 후보 풀 자체가 40종목
    // 뿐이라 실제보다 훨씬 적은 개수(실측: 17개, 완전판 기준 37개)로 나오는데, 이걸 그대로 캐시해버리면
    // program이 몇 초 뒤 295종목 완전판으로 채워져도 당일교집합 캐시(장마감 후 프리징 정책)는 이 부분판
    // 스냅샷에 계속 고정된다(수칙 2-1에서 재현 확인: node scratch/verify_21_checks_regression.js 재실행에도
    // 계속 FAIL). fallback 가격 오염과 동일한 원칙(fail-open, 캐시만 스킵)으로 처리한다.
    const hasPartialProgramContamination = !!programRes.isPartial;
    if (masterData.list && masterData.list.length > 0 && !hasFallbackContamination && !hasPartialProgramContamination) {
      overlapMemoryCache.set(masterCacheKey, { data: masterData, timestamp: Date.now() });
      // syncSharedRankCache: 뱃지 요약 전용 경량 캐시(symbol/rank/statusBadge 등 일부 필드만) -
      // getStockBadgeSummary가 계속 쓰므로 그대로 유지한다.
      syncSharedRankCache(masterCacheKey, masterData.list);
      // 🚨 [버그 수정 - 근본 원인] 처음 시도 때 위 syncSharedRankCache(트림된 요약본)를 "완전한 랭킹
      // 리스트"인 것처럼 오인해 그대로 읽어다 화면에 냈다가, name/currentPrice/isCreditAvailable 등
      // 화면에 필요한 핵심 필드가 통째로 undefined가 되는 회귀를 만들었다(골든 스냅샷 검증으로 발견,
      // batchCollector.ts의 program 배치에서 동일 원리로 이미 재검증 완료). 뱃지 요약 캐시와 절대
      // 충돌하지 않도록 완전히 별도의 cache_key('full:' 접두사)에 RankingItem 전체(masterData.list,
      // 트림 없음)를 따로 저장한다 - 같은 테이블(shared_rank_cache) 재사용, 새 스키마 불필요(수칙 1-6).
      upsertSharedRankCache(`full:${masterCacheKey}`, masterData.list).catch(() => {});
    } else if (hasFallbackContamination) {
      console.warn(`[Overlap Master Cache Skip] fallback 가격 오염 감지(${[...fallbackPricedSymbols].join(',')}) - 이번 결과는 캐시하지 않고 다음 요청에서 재계산`);
    } else if (hasPartialProgramContamination) {
      console.warn('[Overlap Master Cache Skip] programRes.isPartial=true(백그라운드 완성 진행 중) - 이번 결과는 캐시하지 않고 다음 요청에서 재계산');
    }
    return masterData;
  } catch (err: any) {
    console.error('💥 [Async Overlap Error DETAIL]:', err?.message || err, err?.stack);
    // 🚨 [버그 수정 - 수칙 1-6] 이 파일의 다른 모든 KST 표시 지점(예: formatKstFirstSeenLabel)은
    // UTC 오프셋 보정을 거치는데, 이 에러 폴백만 서버 로컬(UTC) 시각을 그대로 썼다 - Vercel은 UTC로
    // 동작하므로 실패 시 lastBatchTime이 실제 KST보다 9시간 어긋나 노출됐다.
    const dateObj = new Date();
    const kstErrDate = new Date(dateObj.getTime() + dateObj.getTimezoneOffset() * 60000 + 9 * 60 * 60000);
    const hours = String(kstErrDate.getHours()).padStart(2, '0');
    const minutes = String(kstErrDate.getMinutes()).padStart(2, '0');
    return {
      type: 'overlap' as RankingType,
      direction,
      period,
      list: [],
      error: `[Async Overlap Error] ${err?.message || err}`,
      isMock: false,
      lastBatchTime: `${hours}:${minutes} 기준`,
      updatedAt: dateObj.toISOString(),
    };
  }
}

const consecutiveOverlapMemoryCache = getGlobalMap<string, { data: InvestorRankingResponse; timestamp: number }>('consecutiveOverlapMemoryCache');
// 🚨 [버그 수정] 원래 30초였다 - 그런데 아래 backgroundCompletion(우선순위 밖 종목까지 마저 채우는 완전판
// 계산)은 실측(.next/dev/logs/next-development.log 03:48~03:50 구간, DB 사전필터 통과 80~81종목 기준)으로
// 최대 108초까지 걸리는 게 확인됐다 - 즉 "완성에 필요한 시간(~108초) > TTL(30초)"이라 완성되기도 전에
// 캐시가 만료되고, 매 요청마다 새 우선순위+백그라운드 계산 사이클이 겹쳐서 쌓이며 같은 kisQueue를
// 서로 잡아먹어 아무 것도 제때 못 끝나는 게 "로컬 무한로딩 / 누를 때마다 계속 계산" 버그의 근본 원인이었다.
// 실측 최대치(108초)보다 여유 있게 180초로 늘려 완성 사이클이 최소 한 번은 안정적으로 끝날 시간을 준다.
const CONSECUTIVE_OVERLAP_CACHE_TTL_MS = 180 * 1000; // 180초 TTL (백그라운드 완전판 계산 실측 최대치보다 여유있게)
// 같은 cacheKey에 대해 백그라운드 완전판 계산이 이미 진행 중이면 새로 하나 더 띄우지 않는다(중복 실행 가드).
// TTL을 늘려도 서버 재시작 직후 콜드스타트처럼 완성이 180초를 넘는 극단적 상황에선 여전히 겹칠 수 있어,
// TTL과 별개로 이중 안전장치로 둔다.
const consecutiveOverlapBackgroundInFlight = getGlobalMap<string, boolean>('consecutiveOverlapBackgroundInFlight');

export function clearConsecutiveOverlapCache() {
  consecutiveOverlapMemoryCache.clear();
}

/**
 * 2일 이상 연속 순매수(또는 순매도)가 진행 중인 주체 2개 이상 중복 교집합 종목 추출
 */
export async function fetchConsecutive2dOverlapRankingData(
  direction: RankingDirection = 'buy',
  minOverlap: number = 2,
  topLimit: number = 50,
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  return fetchConsecutiveNDaysOverlapRankingData(direction, minOverlap, topLimit, market, 2);
}

/**
 * 3일 이상 연속 순매수(또는 순매도)가 진행 중인 주체 2개 이상 중복 교집합 종목 추출
 */
export async function fetchConsecutive3dOverlapRankingData(
  direction: RankingDirection = 'buy',
  minOverlap: number = 2,
  topLimit: number = 50,
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  return fetchConsecutiveNDaysOverlapRankingData(direction, minOverlap, topLimit, market, 3);
}

/**
 * 2일/3일연속 교집합 후보(stockTrends) 배열을 받아 실제 판정 계산부터 캐시 저장까지 마무리한다.
 * 우선순위 30종목만으로 빠르게 응답할 때(writeDropouts=false)와, 백그라운드에서 전 후보를 다 채운 뒤
 * 최종 확정할 때(writeDropouts=true) 양쪽에서 동일한 로직을 재사용해서 두 경로가 절대 어긋나지 않게 한다.
 * writeDropouts=false일 때는 "이탈 종목" 추적 기록을 절대 하지 않는다 - 안 그러면 이번 회차에 아직
 * 평가하지 않은(뒤에서 계속 계산 중인) 종목을 "이탈"로 오판하는, 예전에 고생해서 고친 것과 같은 버그가
 * 재발하기 때문이다.
 */
async function finalizeConsecutiveOverlapResult(
  stockTrends: Array<{ stock: any; trendRes: any; programDaily: ProgramTradeDailyPoint[] }>,
  targetDays: number,
  minOverlap: number,
  direction: RankingDirection,
  market: MarketType,
  cacheKey: string,
  todayStr: string,
  prevActive: Array<any>,
  writeDropouts: boolean,
  isPartial: boolean
): Promise<InvestorRankingResponse> {
  const isBuy = direction === 'buy';
  const ALL_ENTITIES: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }> = [
    { type: 'foreign', label: '외국인' },
    { type: 'organ', label: '기관' },
    { type: 'program', label: '프로그램' },
  ];

  const results: RankingItem[] = [];
  // "이탈 종목" 탭용: 이번 회차에 평가된(=당일 교집합 상위 후보군에 있었던) 종목별 사유 기록
  const evaluatedMap = new Map<string, {
    name: string;
    reason: string;
    reasonBadges?: Array<{ type: 'foreign' | 'organ' | 'program'; label: string; detail: string }>;
    ranksByType?: OverlapInvestorRank[];
    netBuyAmtEok?: number;
    currentPrice?: number;
    netBuyQty?: number;
    netBuyAmt?: number;
    changeRate?: number;
    promoted?: boolean;
  }>();

  for (const { stock, trendRes, programDaily } of stockTrends) {
    if (!trendRes || !trendRes.trend || trendRes.trend.length === 0) {
      evaluatedMap.set(stock.symbol, { name: stock.name, reason: '당일 수급 데이터 조회 실패' });
      continue;
    }
    const trend = trendRes.trend;
    const fullTrend = trend;
    if (fullTrend.length < targetDays) {
      evaluatedMap.set(stock.symbol, { name: stock.name, reason: `거래 이력 부족(최근 ${targetDays}일치 데이터 없음)` });
      continue;
    }

    // Active trend days for Foreigner & Organ
    const activeFullDays = fullTrend.filter(
      (d: InvestorTrendDay) =>
        Math.abs(d.foreignNetBuyAmt || 0) > 0 ||
        Math.abs(d.organNetBuyAmt || 0) > 0
    );
    if (activeFullDays.length < targetDays) {
      evaluatedMap.set(stock.symbol, { name: stock.name, reason: `최근 실제 매매일수 부족(${targetDays}일 미만)` });
      continue;
    }
    const lastNDays = activeFullDays.slice(-targetDays);

    // Strict Day-by-Day Check: EVERY day in the N-day period must have at least minOverlap (2+) entities buying
    const dayByDayCounts = lastNDays.map((d: InvestorTrendDay) => {
      let cnt = 0;
      if (isBuy ? d.foreignNetBuyAmt > 0 : d.foreignNetBuyAmt < 0) cnt++;
      if (isBuy ? d.organNetBuyAmt > 0 : d.organNetBuyAmt < 0) cnt++;
      const pPoint = programDaily.find((p) => p.date === (d.stck_bsop_date || d.date));
      if (pPoint && (isBuy ? pPoint.totalNetBuyAmt > 0 : pPoint.totalNetBuyAmt < 0)) cnt++;
      return cnt;
    });

    const isStrictConsecutiveOverlap = dayByDayCounts.every((cnt: number) => cnt >= minOverlap);
    if (!isStrictConsecutiveOverlap) {
      const weakDayIdx = dayByDayCounts.findIndex((cnt: number) => cnt < minOverlap);
      const weakDate = lastNDays[weakDayIdx]?.stck_bsop_date || lastNDays[weakDayIdx]?.date || '';
      evaluatedMap.set(stock.symbol, {
        name: stock.name,
        reason: `최근 ${targetDays}일 중 ${weakDate ? `${weakDate.slice(4, 6)}/${weakDate.slice(6, 8)}` : '특정일'}에 동시매수 주체가 ${minOverlap}개 미만으로 하루라도 끊김`,
      });
      continue;
    }

    // Calculate backward consecutive days for each investor entity over activeFullDays
    let foreignConsecutiveDays = 0;
    for (let k = activeFullDays.length - 1; k >= 0; k--) {
      const amt = activeFullDays[k].foreignNetBuyAmt || 0;
      if (isBuy ? amt > 0 : amt < 0) foreignConsecutiveDays++;
      else break;
    }

    let organConsecutiveDays = 0;
    for (let k = activeFullDays.length - 1; k >= 0; k--) {
      const amt = activeFullDays[k].organNetBuyAmt || 0;
      if (isBuy ? amt > 0 : amt < 0) organConsecutiveDays++;
      else break;
    }

    // Program consecutive days from programDaily (sorted by date descending)
    let programConsecutiveDays = 0;
    for (const p of programDaily) {
      const amt = p.totalNetBuyAmt || 0;
      if (isBuy ? amt > 0 : amt < 0) programConsecutiveDays++;
      else break;
    }

    const isForeignConsecutive = foreignConsecutiveDays >= targetDays;
    const isOrganConsecutive = organConsecutiveDays >= targetDays;
    const isProgramConsecutive = programConsecutiveDays >= targetDays;

    const ranksByType: OverlapInvestorRank[] = [];

    // 1. 외국인 (실제 연속일수 100% 보존 단일화)
    if (foreignConsecutiveDays > 0) {
      const sumAmt = isForeignConsecutive
        ? lastNDays.reduce((acc: number, d: InvestorTrendDay) => acc + d.foreignNetBuyAmt, 0)
        : (activeFullDays[activeFullDays.length - 1]?.foreignNetBuyAmt || 0);
      ranksByType.push({
        type: 'foreign',
        label: '외국인',
        rank: isForeignConsecutive ? 1 : 0,
        isRanked: isForeignConsecutive,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays: foreignConsecutiveDays,
        consecutiveText: foreignConsecutiveDays >= 2 ? `${foreignConsecutiveDays}일연속` : '당일순매수',
        asOfDateLabel: '당일 가집계',
      });
    }

    // 2. 기관 (실제 연속일수 100% 보존 단일화)
    if (organConsecutiveDays > 0) {
      const sumAmt = isOrganConsecutive
        ? lastNDays.reduce((acc: number, d: InvestorTrendDay) => acc + d.organNetBuyAmt, 0)
        : (activeFullDays[activeFullDays.length - 1]?.organNetBuyAmt || 0);
      ranksByType.push({
        type: 'organ',
        label: '기관',
        rank: isOrganConsecutive ? 1 : 0,
        isRanked: isOrganConsecutive,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays: organConsecutiveDays,
        consecutiveText: organConsecutiveDays >= 2 ? `${organConsecutiveDays}일연속` : '당일순매수',
        asOfDateLabel: '당일 가집계',
      });
    }

    // 3. 프로그램 (실제 연속일수 100% 보존 단일화)
    if (programConsecutiveDays > 0) {
      const sumAmt = isProgramConsecutive
        ? programDaily.slice(0, targetDays).reduce((acc: number, p: ProgramTradeDailyPoint) => acc + p.totalNetBuyAmt, 0)
        : (programDaily[0]?.totalNetBuyAmt || 0);
      ranksByType.push({
        type: 'program',
        label: '프로그램',
        rank: isProgramConsecutive ? 1 : 0,
        isRanked: isProgramConsecutive,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays: programConsecutiveDays,
        consecutiveText: programConsecutiveDays >= 2 ? `${programConsecutiveDays}일연속` : '당일순매수',
        asOfDateLabel: getSettledAsOfDateLabel(),
      });
    }

    const consecutiveEntities = ranksByType.filter((r) => (r.consecutiveDays || 0) >= targetDays);
    const consecutiveOverlapCount = consecutiveEntities.length;

    // 2일연속 탭 전용 상위 등급(3일연속) 중복 제외: 이미 3일+ 연속으로 minOverlap 이상 주체가 매수 중인 종목은
    // "2일연속 교집합" 탭이 아니라 "3일연속 교집합" 탭에만 노출되어야 하므로, 여기서 걸러낸다.
    const qualifiesForNextTier =
      targetDays === 2 && ranksByType.filter((r) => (r.consecutiveDays || 0) >= 3).length >= minOverlap;

    // 2일/3일 연속 교집합의 절대 요건: 실제 targetDays(2일/3일) 이상 연속 매수한 주체가 minOverlap(2개) 이상이어야 함!
    if (consecutiveOverlapCount >= minOverlap && !qualifiesForNextTier) {
      const ENTITY_ORDER: Record<string, number> = { foreign: 1, organ: 2, program: 3 };
      ranksByType.sort((a, b) => {
        const isConsecA = (a.consecutiveDays || 0) >= targetDays ? 1 : 0;
        const isConsecB = (b.consecutiveDays || 0) >= targetDays ? 1 : 0;
        if (isConsecB !== isConsecA) return isConsecB - isConsecA;
        return (ENTITY_ORDER[a.type] || 99) - (ENTITY_ORDER[b.type] || 99);
      });

      const latest = trend[trend.length - 1];
      const consecutiveLabels = consecutiveEntities.map((r) => r.label);
      const totalNetBuyAmt = ranksByType.reduce((sum, r) => sum + r.netBuyAmt, 0);
      const totalNetBuyAmtEok = Number((totalNetBuyAmt / 100).toFixed(1));
      const investorBadge = `${consecutiveOverlapCount}개 주체 ${targetDays}일+ 연속중복 (${consecutiveLabels.join(' · ')})`;
      const missingEntities = ALL_ENTITIES.filter((e) => !ranksByType.some((r) => r.type === e.type));

      const price = latest.closePrice || stock.currentPrice || 0;
      const totalNetBuyQty = price > 0 ? Math.round((totalNetBuyAmt * 1000000) / price) : 0;

      const statusInfo = computeStatusBadgeFromTrend(trend);
      results.push({
        rank: 0,
        symbol: stock.symbol,
        name: getStockName(stock.symbol, trendRes.stockInfo?.name || stock.name),
        currentPrice: price,
        change: latest.priceChange || 0,
        changeRate: latest.changeRate || 0,
        netBuyQty: totalNetBuyQty,
        netBuyAmt: totalNetBuyAmt,
        netBuyAmtEok: totalNetBuyAmtEok,
        // 🚨 [버그 수정 - 수칙 1-3] 거래량 미확보 시 가짜 100만주로 채우고 있었다 - 화면(정렬 기준 포함)에
        // 실데이터처럼 노출되므로 정직하게 0으로 표시한다(바로 아래 ratioVsVolume은 이미 0 처리하고 있었음).
        volume: latest.volume || 0,
        ratioVsVolume: (latest.volume || 0) > 0 ? Number(((Math.abs(totalNetBuyQty) / latest.volume!) * 100).toFixed(1)) : 0,
        foreignNetBuyAmt: ranksByType.find((r) => r.type === 'foreign')?.netBuyAmt,
        organNetBuyAmt: ranksByType.find((r) => r.type === 'organ')?.netBuyAmt,
        programNetBuyAmt: ranksByType.find((r) => r.type === 'program')?.netBuyAmt,
        // 🚨 [버그 수정 - 애프터마켓 도입 후 발견] 위 executeAsyncOverlapCalculation과 동일한 이유(수칙
        // 1-6, getLiveOrSettledAsOfLabel 공용 함수 재사용).
        asOfDateLabel: getLiveOrSettledAsOfLabel(),
        overlapCount: consecutiveOverlapCount,
        investorBadge,
        statusBadge: statusInfo?.shortBadge,
        statusBadgeStyle: statusInfo?.badgeStyle,
        ranksByType,
        missingEntities,
      });
    } else if (qualifiesForNextTier) {
      // 3일+ 연속으로 승격되어 다음 등급 탭에만 노출되는 경우 - "밀려남"이 아니라 "승격"이므로 이탈로 취급하지 않음
      evaluatedMap.set(stock.symbol, { name: stock.name, reason: '', ranksByType, promoted: true });
    } else {
      const latest = trend[trend.length - 1];
      const totalNetBuyAmt = ranksByType.reduce((sum, r) => sum + r.netBuyAmt, 0);
      const netBuyAmtEok = Number((totalNetBuyAmt / 100).toFixed(1));
      const price = latest?.closePrice || stock.currentPrice || 0;
      const totalNetBuyQty = price > 0 ? Math.round((totalNetBuyAmt * 1000000) / price) : 0;
      // 이미 계산해둔 ranksByType/ALL_ENTITIES에서 바로 뽑아내는 값이라 추가 조회나 추정 없이 정확하다.
      const reasonBadges: Array<{ type: 'foreign' | 'organ' | 'program'; label: string; detail: string }> = [
        ...ranksByType
          .filter((r) => (r.consecutiveDays || 0) > 0 && (r.consecutiveDays || 0) < targetDays)
          .map((r) => ({ type: r.type, label: r.label, detail: `${r.consecutiveDays}일로 하회` })),
        ...ALL_ENTITIES
          .filter((e) => !ranksByType.some((r) => r.type === e.type))
          .map((e) => ({ type: e.type, label: e.label, detail: '매수 중단' })),
      ];
      const reason = reasonBadges.length > 0
        ? reasonBadges.map((b) => `${b.label} ${b.detail}`).join(', ')
        : `동시매수 주체 수 부족(기준 ${minOverlap}개 이상)`;
      evaluatedMap.set(stock.symbol, {
        name: stock.name,
        reason,
        reasonBadges,
        ranksByType,
        netBuyAmtEok,
        currentPrice: price,
        netBuyQty: totalNetBuyQty,
        netBuyAmt: totalNetBuyAmt,
        changeRate: latest?.changeRate || 0,
      });
    }
  }

  // Sort: 1. 실제 N일 연속 매수 주체 수 (4 > 3 > 2), 2. 누적 금액
  results.sort((a, b) => {
    const countA = a.overlapCount || 0;
    const countB = b.overlapCount || 0;
    if (countB !== countA) {
      return countB - countA;
    }
    return isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
  });

  results.forEach((item, idx) => {
    item.rank = idx + 1;
  });

  // "이탈 종목" 추적: 직전 활성 스냅샷과 이번 결과를 비교해 새로 밀려난 종목을 Supabase에 기록한다.
  // writeDropouts=false(우선 30종목 미리보기)일 때는 절대 기록하지 않는다 - 뒤에서 계속 계산 중인 종목을
  // "이탈"로 오판하는 걸 막기 위함. 전체 계산이 끝난 뒤(writeDropouts=true)에만 기록한다.
  // 실패해도 본 기능(랭킹 조회)에는 영향이 없도록 무음 실패 처리한다.
  if (writeDropouts) {
    try {
      const currentSymbols = new Set(results.map((r) => r.symbol));

      // "당일 교집합"과 동일한 컬럼(현재가/순매수 수량/합산 순매수)을 이탈 종목 화면에도 그대로 보여주기 위해
      // ranks_by_type(jsonb) 컬럼에 주체별 상세와 함께 마지막으로 확인된 숫자 스냅샷을 같이 담아 저장한다.
      const buildSnapshotPayload = (
        ranks: OverlapInvestorRank[] | undefined,
        currentPrice?: number,
        netBuyQty?: number,
        netBuyAmt?: number,
        changeRate?: number,
        reasonBadges?: Array<{ type: string; label: string; detail: string }>
      ) => ({
        ranks: ranks || [],
        currentPrice: currentPrice || 0,
        netBuyQty: netBuyQty || 0,
        netBuyAmt: netBuyAmt || 0,
        changeRate: changeRate || 0,
        reasonBadges: reasonBadges || [],
      });

      const watchRows: Array<{ symbol: string; name: string; status: 'active' | 'dropped'; ranksByType?: any; netBuyAmtEok?: number; dropReason?: string }> = [];

      // 1. 직전엔 있었는데 이번엔 없는 종목 = 새로 밀려난 종목
      prevActive.forEach((prev) => {
        if (currentSymbols.has(prev.symbol)) return; // 여전히 명단에 있음 - 이탈 아님
        const evaluated = evaluatedMap.get(prev.symbol);
        if (evaluated?.promoted) return; // 다음 등급(3일연속)으로 승격된 것 - 이탈 아님
        const prevSnapshot = prev.ranksByType as any; // 직전 저장분: buildSnapshotPayload 형태
        // 이번 회차에 다시 평가된 경우(evaluated 존재)만 정확한 사유 배지를 계산한다.
        // 당일 후보군(상위 8위) 밖으로 완전히 벗어나 재평가 자체가 안 된 경우는 정밀한 사유를
        // 억지로 추정하지 않고 "이탈"이라는 단순 분류로만 표시한다.
        const reason = evaluated ? evaluated.reason : '이탈';
        watchRows.push({
          symbol: prev.symbol,
          name: prev.name,
          status: 'dropped',
          ranksByType: evaluated
            ? buildSnapshotPayload(evaluated.ranksByType, evaluated.currentPrice, evaluated.netBuyQty, evaluated.netBuyAmt, evaluated.changeRate, evaluated.reasonBadges)
            : buildSnapshotPayload(prevSnapshot?.ranks, prevSnapshot?.currentPrice, prevSnapshot?.netBuyQty, prevSnapshot?.netBuyAmt, prevSnapshot?.changeRate, []),
          netBuyAmtEok: evaluated?.netBuyAmtEok ?? prev.netBuyAmtEok,
          dropReason: reason,
        });
      });

      // 2. 현재 명단은 active로 갱신 (다음 회차 비교의 기준이 됨)
      results.forEach((r) => {
        watchRows.push({
          symbol: r.symbol,
          name: r.name,
          status: 'active',
          ranksByType: buildSnapshotPayload(r.ranksByType, r.currentPrice, r.netBuyQty, r.netBuyAmt, r.changeRate),
          netBuyAmtEok: r.netBuyAmtEok,
        });
      });

      // 🚨 [성능 수정] 예전엔 이 기록을 await해서 사용자 응답을 막았다 - 콜드스타트 직후 여러 컴포넌트가
      // 동시에 kisQueue에 몰리는 상황(실측: 108초)에서, 이 Supabase 쓰기까지 응답 경로에 얹혀 불필요하게
      // 지연을 더하고 있었다. 바로 위(2447줄) insertDailyOverlapFirstSeenIfMissing과 동일하게, 응답 지연
      // 없이 백그라운드로 기록하고 실패해도(화면 표시엔 지장 없음) 조용히 넘어가도록 바꾼다.
      if (watchRows.length > 0) {
        upsertConsecutiveOverlapWatch(todayStr, targetDays, direction, market, watchRows).catch((e) =>
          console.warn('[Consecutive Overlap Dropout Tracking Background Failed]', e?.message || e)
        );
      }
    } catch (e: any) {
      console.warn('[Consecutive Overlap Dropout Tracking Failed]', e?.message || e);
    }
  }

  // Calculate Risk-Adjusted AI Pick Candidates (Matching 1st~6th Buy Timing Hierarchy)
  const aiPickCandidates = [...results]
    .filter((item) => isEntryReadyBadge(item.statusBadge)) // 단기과열 종목은 별표(AI픽) 후보군에서 제외
    .filter((item) => !isEtfSymbol(item.symbol, item.name)) // 레버리지/인버스 등 ETF·ETN은 개별 종목 추천 취지에 안 맞아 AI픽 후보군에서 제외 (사용자 요청: "레버리지관련 종목은 다 빼서 추천")
    .map((item) => ({
      symbol: item.symbol,
      score: computeOverlapAiPickScore(item),
    }))
    .sort((a, b) => b.score - a.score);

  const top5Symbols = aiPickCandidates.slice(0, 5).map((c) => c.symbol);

  results.forEach((item) => {
    const pickIdx = top5Symbols.indexOf(item.symbol);
    item.aiPickRank = pickIdx >= 0 ? pickIdx + 1 : undefined;
  });

  const mergedList = await mergeCreditStatusToRanking(results);

  const masterData: InvestorRankingResponse = {
    type: 'overlap',
    direction,
    period: `consecutive${targetDays}d` as any,
    list: mergedList,
    updatedAt: new Date().toISOString(),
    isPartial,
  };

  if (masterData.list && masterData.list.length > 0) {
    consecutiveOverlapMemoryCache.set(cacheKey, { data: masterData, timestamp: Date.now() });
    // 🚨 [버그 수정 - 근본 원인] isPartial(우선순위 15종목 단계)일 때도 그대로 공유 캐시에 썼었다 - 다른
    // 서버리스 인스턴스가 이 부분판(5종목 등)을 완전판으로 오인해 반환할 위험이 있었다. 완전판일 때만
    // 인스턴스 간 공유 캐시에 올린다(당일교집합/프로그램매매와 동일 원칙, 수칙 1-6).
    if (!isPartial) {
      // syncSharedRankCache: 뱃지 요약 전용 경량 캐시(symbol/rank/statusBadge 등 일부 필드만) -
      // getStockBadgeSummary가 계속 쓰므로 그대로 유지한다.
      syncSharedRankCache(cacheKey, masterData.list);
      // 완전한 RankingItem 전체(트림 없음)는 별도의 cache_key('full:' 접두사)에 따로 저장한다 - 뱃지
      // 요약 캐시와 절대 충돌하지 않는다(같은 shared_rank_cache 테이블 재사용, 새 스키마 불필요).
      upsertSharedRankCache(`full:${cacheKey}`, masterData.list).catch(() => {});
    }
  }

  return masterData;
}

export async function fetchConsecutiveNDaysOverlapRankingData(
  direction: RankingDirection = 'buy',
  minOverlap: number = 2,
  topLimit: number = 50,
  market: MarketType = 'ALL',
  targetDays: number = 3
): Promise<InvestorRankingResponse> {
  // 🚨 [로컬 자가치유] 이 계산이 과거일 소스로 쓰는 raw_daily_data는 배포 환경에선 Vercel Cron이
  // 매일 채워주지만, 로컬 개발(npm run dev)에선 그 Cron이 전혀 안 돌아서 최근 며칠이 계속 비어있는
  // 채로 남는다 - 그 결과 배지 계산에 ma20 등이 null이 되어 실제 이격도와 안 맞는 값이 나오는 문제가
  // 있었다(사용자 실측). 요청을 막지 않는 백그라운드 트리거(30분 잠금)로 빈 날짜를 알아서 채운다 -
  // 배포 환경에서도 안전하다(이미 있는 값을 같은 값으로 재upsert할 뿐).
  import('./batchCollector').then(({ triggerRawDailyDataBackfillIfStale }) => {
    triggerRawDailyDataBackfillIfStale();
  }).catch(() => {});

  const cacheKey = `c_${direction}_${targetDays}d_${minOverlap}_${market}_${topLimit}`;
  const cached = consecutiveOverlapMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONSECUTIVE_OVERLAP_CACHE_TTL_MS) {
    return cached.data;
  }

  // 🚨 [버그 수정] TTL(180초)이 만료됐다고 해서 무조건 새로 계산을 시작하면 안 된다 - 이미 이 cacheKey에
  // 대해 백그라운드 완전판 계산이 진행 중인데(consecutiveOverlapBackgroundInFlight), 그게 180초보다
  // 오래 걸리는 실제 상황(사용자 실측 확인: 30분 넘게 "상위 종목 우선 표시 중"에서 안 벗어남)에서는
  // TTL 만료 시점마다 여기부터 다시 우선순위 15종목 라이브 재계산이 매번 새로 실행됐다 - 이게 캐시를
  // "다시 isPartial:true, 극소수 종목짜리"로 덮어써버려서, 뒤에서 조용히 잘 진행되고 있던 완전판 계산의
  // 최종 결과가 화면에 반영될 기회를 영영 못 잡고 계속 밀려나는(신선한 재시작이 완료를 추월) 문제였다.
  // 이미 진행 중인 완전판 계산이 있으면 새로 계산을 시작하지 않고, 있는 캐시(TTL 지났어도)를 그대로
  // 돌려준다 - 완전판이 끝나면 그 백그라운드 작업이 알아서 캐시를 갱신한다.
  if (consecutiveOverlapBackgroundInFlight.get(cacheKey) && cached) {
    return cached.data;
  }

  // 🚨 [버그 수정 - 근본 원인: 서버리스 인스턴스 간 캐시 불일치] 이 인메모리 캐시(consecutiveOverlapMemoryCache)는
  // 프로세스 로컬이라, Vercel이 새 서버리스 인스턴스로 요청을 라우팅하면 완전히 비어있는 채로 시작한다 -
  // 다른 인스턴스가 이미 백그라운드로 완전판(우선순위 15종목 + 나머지 후보 전부)을 다 계산해놔도 그 사실을
  // 전혀 모르고 처음부터 다시 우선순위 15종목짜리 부분판(isPartial:true)을 계산한다(실측: 사용자가
  // 프로덕션에서 "2일연속 5종목"만 반복해서 봄 - 로컬 단일 프로세스로 재현하니 실제 완전판은 23종목이었고,
  // 매 프로덕션 요청마다 updatedAt이 달라져 매번 처음부터 재계산되고 있었음을 확인). 라이브 계산을 시작하기
  // 전에, 다른 인스턴스가 이미 Supabase에 올려둔 완전판이 있는지 먼저 확인한다(당일교집합/프로그램매매와
  // 동일 패턴, 수칙 1-6).
  // 🚨 [버그 수정 - 재설계] maxAgeMs를 처음엔 로컬 재계산 주기(CONSECUTIVE_OVERLAP_CACHE_TTL_MS=180초)와
  // 똑같이 180초로 잡았었다 - "로컬 프로세스가 얼마나 자주 재계산할지"와 "다른 인스턴스가 얼마나 오래된
  // 공유 캐시를 믿고 재사용할지"는 서로 다른 문제인데 같은 값으로 착각해 묶어버린 설계 실수였다. 그
  // 결과 트래픽이 뜸한 실사용 환경에서는 "누군가 180초 이내에 이미 계산해뒀을" 확률이 낮아, 사용자가
  // 매번 35~138초짜리 라이브 재계산(느리게 채워지는 현상)을 그대로 겪는 걸 실측으로 확인했다(사용자 지적:
  // "몇초안에 채워진다해놓고 너무 느리게 채워지는데?"). 2일/3일연속 매수 여부는 당일교집합과 마찬가지로
  // 며칠 단위로 움직이는 지표라 몇 분~몇십 분 정도 오래된 값을 재사용해도 실질적 문제가 없다 - 당일교집합/
  // 프로그램매매와 동일하게 24시간으로 맞춘다. 로컬 프로세스 자체 재계산 주기(180초, 이탈 종목 추적 정확도
  // 목적)는 그대로 유지 - 이건 아래 CONSECUTIVE_OVERLAP_CACHE_TTL_MS 로컬 캐시 체크에만 계속 쓰인다.
  // 🚨 [버그 수정 - 수칙 1-6] "24시간"이 위 문단 판단(연속매수 멤버십 자체는 며칠 단위로 안 바뀜)으로는
  // 맞았지만, 시계로 고정 24시간을 세는 방식이라 영업일 경계를 몰랐다 - 이 캐시 안에는 멤버십뿐 아니라
  // 그 시점의 현재가/추세배지(statusBadge)도 같이 박제되는데, 전날 장마감 후(예: 20:45)에 쓰인 캐시가
  // "아직 24시간 안 지났다"는 이유만으로 다음날 09:00~15:30 장이 통째로 열렸다 닫혀도 계속 재사용되어
  // 어제 저녁 가격 기준 배지가 하루 종일 나가는 회귀로 이어졌다(fetchOverlapRankingData의 동일 버그를
  // 삼성E&A 028050 실측으로 먼저 확인 - 위 2459번 줄 부근 주석 참고). 인메모리 캐시(line 3469)와
  // 완전히 별개 정책이던 것을 dynamicTtl로 한 번 통일했더니, 이번엔 "오늘 장중 10:02에 기록된
  // 스냅샷이 duration이 안 지났다는 이유로 장마감 후에도 계속 신선하다고 오판"되는 2차 회귀가 실측으로
  // 확인됐다(삼성E&A 028050 3일연속 탭 - 10:02 스냅샷 가격 49150원을 17시대까지 그대로 씀, 실제
  // 종가는 50800원). duration이 아니라 "가장 최근 마감(15:30) 이후에 기록됐는가"를 보는
  // getSharedCacheMaxAgeMs()로 다시 교체한다 - 인메모리 캐시 쪽은 그대로 dynamicTtl 유지(그쪽은 이
  // 프로세스가 언제 마지막으로 "직접" 계산했는지만 보므로 duration으로 충분하다).
  const dynamicTtl = getDynamicRankingTtl();
  if (!cached) {
    const sharedMap = await fetchSharedRankCacheBatch([`full:${cacheKey}`], getSharedCacheMaxAgeMs()).catch(() => new Map<string, any[]>());
    const sharedList = sharedMap.get(`full:${cacheKey}`);
    if (sharedList && sharedList.length > 0) {
      console.log(`[Shared Rank Cache Hit] full:${cacheKey} - 다른 인스턴스가 이미 계산해둔 ${targetDays}일연속 교집합 완전판을 Supabase에서 재사용`);
      const hydrated: InvestorRankingResponse = {
        type: 'overlap',
        direction,
        period: `consecutive${targetDays}d` as any,
        list: sharedList,
        updatedAt: new Date().toISOString(),
        isPartial: false,
      };
      consecutiveOverlapMemoryCache.set(cacheKey, { data: hydrated, timestamp: Date.now() });
      return hydrated;
    }
  }

  const isBuy = direction === 'buy';
  const { getCached5dTrend, setCached5dTrend } = await import('./batchCollector');

  const now = new Date();
  const utcNow = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstNow = new Date(utcNow + 9 * 60 * 60000);
  const todayStr = `${kstNow.getFullYear()}${String(kstNow.getMonth() + 1).padStart(2, '0')}${String(kstNow.getDate()).padStart(2, '0')}`;

  // Get candidate stocks from real-time market overlap ranking (no fixed stock list restriction!)
  const dailyOverlapRes = await fetchOverlapRankingData(direction, '1d', 2, 50, market).catch(() => null);
  const candidateStocks = dailyOverlapRes?.list || [];

  // 직전에 이미 이 등급(2일/3일연속)에서 활성 상태였던 종목 스냅샷을 먼저 가져온다.
  let prevActive = await fetchConsecutiveOverlapWatch(todayStr, targetDays, direction, market, 'active').catch(() => []);
  // 오늘 첫 계산이라 당일 스냅샷이 아직 없으면(장 시작 직후 등), "어제 마감 대비 오늘 이탈"을 그 즉시
  // 잡아낼 수 있도록 직전 영업일의 마감 active 스냅샷으로 시작한다 - 히스토리 페이지("직전 영업일 대비
  // 비교")와 라이브 탭의 이탈 판정 기준을 동일하게 맞추기 위함(하루 안의 미세 변화만 보던 기존 한계 보완).
  if (prevActive.length === 0) {
    prevActive = await fetchLatestActiveBeforeDate(todayStr, targetDays, direction, market).catch(() => []);
  }

  // 2일/3일연속 여부는 "오늘 상위 몇 위"가 아니라 당일 2개 이상 주체가 동시매수 중인 전 종목(candidateStocks,
  // 최대 50개) 전부를 대상으로 판정해야 한다 - 오늘 순매수 금액 순위가 낮더라도 여러 날 연속 매수가 이어지는
  // 종목을 놓치면 안 되기 때문. 과거에는 상위 8위만 봐서, 오늘 특정 주체가 매도해 당일 순위가 밀린 종목의
  // 실제 연속매수 여부를 아예 재평가하지 못하고 "이탈"로 잘못 분류하는 문제가 있었다.
  const top50Symbols = new Set(candidateStocks.map((s) => s.symbol));
  // 혹시 당일 상위 50위 명단에서도 완전히 빠졌지만 직전엔 활성이었던 종목까지 안전망으로 포함(드문 경우 대비).
  // candidateStocks에 없으므로 직전 스냅샷(prevActive)에 남아있는 최소 정보(symbol/name)로 재구성한다.
  const carriedOver = prevActive
    .filter((p) => !top50Symbols.has(p.symbol))
    // 예전에 잘못 저장된 이름(예: "319660" 숫자 코드 그대로)이 계속 이월되며 자가 재생산되는 걸 막기 위해
    // getStockName으로 매번 다시 보정한다 - fallback인 p.name이 symbol과 같으면(=이름 해석 실패였던 경우)
    // TOP_300_STOCKS 등 마스터 카탈로그에서 정식 이름을 다시 찾는다.
    .map((p) => ({ symbol: p.symbol, name: getStockName(p.symbol, p.name), currentPrice: 0 } as any));
  const targetCandidates = [...candidateStocks, ...carriedOver];

  // 콜드스타트 응답 지연 최소화를 위해, 후보가 많을 때는 상위 PRIORITY_LIMIT개만 먼저 계산해서
  // 즉시 응답(isPartial:true)하고, 나머지는 응답을 보낸 뒤 백그라운드에서 이어서 계산해 캐시를 완전판으로
  // 갱신한다. candidateStocks(당일교집합 순매수금액 순)가 앞쪽에 오므로 "가장 유력한 후보부터" 먼저 보여준다.
  //
  // 🚨 [성능 수정] 종목당 라이브 KIS 호출이 2건(수급동향+프로그램매매)이고 전부 하나의 kisQueue(300ms
  // 직렬 간격)를 공유한다 - 예전 값(30)은 "30개 × 1초 ≈ 30초 이내"를 가정했지만, 실측으로는 콜드스타트
  // 직후 다른 컴포넌트(지수카드, 종목상세차트 등)까지 같은 큐에 몰리면서 108초까지 걸리는 게 확인됐다.
  // 후보 수를 줄이면 그만큼 이번 요청이 큐를 점유하는 시간이 줄어 전체 정체가 완화된다 - 완전판은 그대로
  // 백그라운드에서 마저 채워지므로(아래 restCandidates 경로) 정확도 손실은 없고, 최초 응답 속도만 개선된다.
  const PRIORITY_LIMIT = 15;
  const priorityCandidates = targetCandidates.slice(0, PRIORITY_LIMIT);
  const restCandidates = targetCandidates.slice(PRIORITY_LIMIT);

  // [과거일 DB 재사용] raw_daily_data(장마감 후 자동 수집, api/cron/collect-raw-daily-data)에서 과거
  // 최대 20영업일치를 먼저 당겨온다 - universeExtra 사전필터(과거 targetDays-1일 게이트)와, 아래 우선순위
  // 후보의 "과거일 라이브 재조회 생략" 양쪽에 재사용한다.
  //
  // 🚨 [주의] 왜 targetDays-1일이 아니라 20일치를 당겨오는가: 처음엔 딱 targetDays-1일만 당겨왔다가 실측
  // 검증 중 진짜 회귀를 하나 만들었었다 - 주체별 실제 연속일수(foreignConsecutiveDays 등)는 trend 배열을
  // 뒤에서부터 끊길 때까지 세는 backward loop인데, trend 배열 자체가 딱 targetDays 길이(=window)로 짧으면
  // 그 이상은 셀 수가 없어서 실제로 4일 연속인 종목도 무조건 "2일연속"/"3일연속"으로 뭉개져 표시됐다
  // (오늘 낮에 /history 페이지에서 고쳤던 것과 정확히 같은 캡핑 버그를 여기서 다시 만들 뻔했다 - 실측:
  // LG에너지솔루션이 2일연속 탭에선 "2일연속", 3일연속 탭에선 "3일연속"으로 서로 다르게 표시되는 걸 보고
  // 발견함). 20일치를 넉넉히 당겨오면 백워드 루프가 진짜 연속일수를 끝까지 셀 수 있다.
  // 🚨 [버그 수정] 20일로는 이 경로의 computeStatusBadgeFromTrend(line ~2881)도 ma60이 항상 null이 되어
  // "바닥 반등"/60일선 기준 단기과열 배지를 절대 못 낸다 - resolveTrendForBadge와 동일 기준(90일)으로
  // 맞춘다(수칙 1-6).
  const DB_HISTORY_LOOKBACK_DAYS = 90;
  const { fetchRawDailyTrailingDays } = await import('./supabase');
  const { dates: trailingDatesFull, bySymbol: trailingBySymbol } = await fetchRawDailyTrailingDays(todayStr, DB_HISTORY_LOOKBACK_DAYS).catch(() => ({ dates: [] as string[], bySymbol: new Map() }));
  // 사전필터(universeExtra) 게이트는 원래 의도대로 "과거 targetDays-1일"만 본다 - 20일치 중 가장 최근 것.
  const trailingDates = trailingDatesFull.slice(-(targetDays - 1));
  const passesDirectionAmt = (amt: number) => (isBuy ? amt > 0 : amt < 0);

  // 당일교집합(dailyOverlapRes/candidateStocks)이 이미 계산해둔 오늘자 외국인/기관/프로그램 순매수
  // (item.ranksByType)를 그대로 재사용해서 "오늘치 확인용" 라이브 재조회를 없앤다 - 이미 손에 쥔 값을
  // 다시 사러 가지 않는다. carriedOver 종목(직전엔 활성이었지만 오늘 당일교집합 상위 50위 밖으로 빠진
  // 종목)은 ranksByType이 없으므로 null을 반환해 아래에서 기존 라이브 방식으로 안전하게 폴백한다.
  const buildTodayAmtsFromRanksByType = (stock: any): { foreign: number; organ: number; program: number } | null => {
    if (!Array.isArray(stock.ranksByType)) return null;
    const get = (type: string) => stock.ranksByType.find((r: any) => r.type === type)?.netBuyAmt ?? 0;
    return { foreign: get('foreign'), organ: get('organ'), program: get('program') };
  };

  const fetchTrendPair = async (stock: any) => {
    // 🚨 [성능 수정] 과거 targetDays-1일치가 DB에 다 있고, 이 종목이 당일교집합 결과에서 온 종목이라
    // 오늘치를 이미 알고 있으면(ranksByType 존재), 외국인/기관 관련 라이브 호출(fetchKisInvestorTrend)을
    // 통째로 생략한다 - raw_daily_data의 외국인/기관 수치는 실측으로 라이브 재조회와 100% 일치 확인됨
    // (삼성전자·삼성전기·SK하이닉스 3종목 대조). 프로그램매매는 raw_daily_data 수집 시점(장마감 18:30)에
    // 아직 미확정인 경우가 실측으로 확인돼서(같은 3종목 중 2개가 저장값 0 vs 실제값 불일치, 날짜별로도
    // 15~17% 종목이 0으로 저장) 과거일 프로그램매매는 당분간 계속 라이브로 조회한다 - 다음날 아침 재수집
    // 패치 크론(vercel.json, collect-raw-daily-data 05~06시 KST 재실행)이 며칠 안정적으로 검증되면 뺀다.
    const todayAmts = buildTodayAmtsFromRanksByType(stock);
    // 게이트 판정(최소 요건)은 targetDays-1일만 다 있으면 되지만, 실제 trend 배열은 백워드 연속일수를
    // 정확히 세기 위해 20일 lookback 중 이 종목이 실제로 가진 만큼(20일 전부 없어도 됨 - 신규상장 등
    // 대비 fail-open) 전부 채워 넣는다.
    const hasFullDbHistory = trailingDates.length >= targetDays - 1 && trailingDates.every((d) => trailingBySymbol.get(stock.symbol)?.has(d));

    if (todayAmts && hasFullDbHistory) {
      const symbolDates = trailingBySymbol.get(stock.symbol)!;
      // 🚨 [버그 수정] closePrice를 0으로 하드코딩했었다 - raw_daily_data DB에 실제 종가가 저장돼 있는데도
      // fetchRawDailyTrailingDays의 select가 가격 컬럼을 안 가져와서 여기선 값이 없는 것처럼 취급됐다.
      // 그 결과 computeStatusBadgeFromTrend(closePrice>0 필터)가 과거 19일을 전부 버려 ma5/ma20/ma60이
      // 항상 null이 되고, 이 최적화 경로를 타는 종목(우선순위 상위 15개)의 배지가 항상 "이평선 수렴"으로
      // 고정되는 문제가 있었다 - 랭킹 목록과 종목 상세 차트의 배지가 서로 다르게 보이던 근본 원인.
      // 이제 select를 고쳐 실제 종가를 받아오므로 그대로 채운다.
      const trend: any[] = trailingDatesFull
        .filter((d) => symbolDates.has(d))
        .map((d) => {
          const row = symbolDates.get(d)!;
          return {
            date: d,
            stck_bsop_date: d,
            closePrice: row.close_price || 0,
            openPrice: row.open_price || 0,
            highPrice: row.high_price || 0,
            lowPrice: row.low_price || 0,
            volume: row.volume || 0,
            changeRate: row.change_rate || 0,
            foreignNetBuyAmt: row.foreign_net_buy_amt || 0,
            organNetBuyAmt: row.organ_net_buy_amt || 0,
          };
        });
      trend.push({
        date: todayStr,
        stck_bsop_date: todayStr,
        closePrice: stock.currentPrice || 0,
        priceChange: stock.change || 0,
        changeRate: stock.changeRate || 0,
        volume: stock.volume || 0,
        foreignNetBuyAmt: todayAmts.foreign,
        organNetBuyAmt: todayAmts.organ,
      });

      // 프로그램매매는 위 이유로 여전히 라이브 1회만 호출한다 - 과거+오늘 전부 이 응답 하나에 들어있다.
      const programDaily = await fetchKisProgramTradeDaily(stock.symbol).catch(() => []);
      return { stock, trendRes: { trend }, programDaily };
    }

    // 폴백: DB 이력 부족(부트스트랩 초반, 신규상장 등) 또는 오늘치 정보 없음(carriedOver 등) - 기존 방식
    // 그대로 완전 라이브 조회한다(fail-open - 없는 데이터를 억지로 재구성하지 않는다).
    const trendRes = await fetchKisInvestorTrend(stock.symbol, '5d').catch(() => null);
    const programDaily = await fetchKisProgramTradeDaily(stock.symbol).catch(() => []);
    return { stock, trendRes, programDaily };
  };

  const priorityResults = await Promise.all(priorityCandidates.map(fetchTrendPair));

  // 당일 상위 50위 교집합 후보에 없는 종목도 2일/3일연속 여부를 봐야 한다(당일 순매수 "금액 순위"가
  // 낮아도 여러 날 연속으로 계속 사고 있을 수 있음). 다만 TOP_300 전 종목을 매번 실시간 조회하면
  // 요청이 지나치게 느려지고 타임아웃 위험이 커서, 배치 컬렉터가 이미 채워둔 캐시(getCached5dTrend,
  // 0ms)가 있는 종목만 보강한다 - 캐시가 없는 종목은 억지로 조회하지 않고 건너뛴다(가짜 데이터 금지).
  // 이 목록은 캐시 기반이라 실시간 조회 비용이 없으므로 우선/전체 계산 양쪽 모두에 그대로 포함시킨다.
  const coveredSymbols = new Set(targetCandidates.map((s) => s.symbol));
  const universeExtra = TOP_300_STOCKS.filter(
    (s) => !coveredSymbols.has(s.symbol) && (market === 'ALL' || s.market === market)
  );

  // [DB 사전필터] 예전에는 universeExtra 전부가 batchCollector의 인메모리 예열 캐시(getCached5dTrend)에만
  // 의존했다 - 서버리스 재시작/HMR로 그 캐시가 비면, 예열 로테이션 커서가 해당 종목을 다시 돌 때까지
  // (최악 4시간) 후보에서 통째로 누락되는 문제가 있었다(실제로 사용자가 지적한 문제). 이제 raw_daily_data
  // (장마감 후 자동 수집 - api/cron/collect-raw-daily-data, 서버 재시작에도 사라지지 않는 DB 영구 저장소)로
  // "과거 targetDays-1일" 게이트를 먼저 통과한 종목만 걸러 라이브 조회 대상을 좁힌다. DB 기록이 없거나
  // 부족한 종목은 배제하지 않고 안전하게 통과시킨다(fail-open - "데이터 없음"을 "조건 미달"로 오판 금지).
  // 당일치는 raw_daily_data에 아직 없으므로(장마감 후에만 적재) 생존 종목은 반드시 라이브로 당일을 확인한다
  // - "당일치를 포함해서 2/3일연속이 되어야 한다"는 요구사항을 그대로 지킨다.

  const dbFilteredUniverse = trailingDates.length < targetDays - 1
    ? universeExtra // DB 축적이 아직 부족(부트스트랩 초반) - 사전필터를 건너뛰고 전부 통과시킨다
    : universeExtra.filter((stock) => {
        const symbolDates = trailingBySymbol.get(stock.symbol);
        if (!symbolDates) return true; // 이 종목의 DB 기록 없음 - 배제하지 않고 라이브로 직접 확인
        for (const d of trailingDates) {
          const row = symbolDates.get(d);
          if (!row) return true; // 특정 일자 기록 누락 - 안전하게 통과(배제 금지)
          let cnt = 0;
          if (passesDirectionAmt(row.foreign_net_buy_amt || 0)) cnt++;
          if (passesDirectionAmt(row.organ_net_buy_amt || 0)) cnt++;
          if (passesDirectionAmt(row.program_net_buy_amt || 0)) cnt++;
          if (cnt < minOverlap) return false; // 과거 특정일에 이미 조건 미달 확인됨 - 오늘 봐도 소용없어 스킵
        }
        return true; // 과거 N-1일 전부 조건 통과 - 오늘 라이브로 마저 확인해야 할 유력 후보
      });

  console.log(`[Consecutive Overlap DB Pre-filter] targetDays=${targetDays} universeExtra=${universeExtra.length}개 → DB 사전필터 통과 ${dbFilteredUniverse.length}개 (트레일링 날짜: ${trailingDates.join(',') || '없음(부트스트랩)'})`);

  // DB 사전필터를 통과한 종목 중, 이미 인메모리 예열 캐시(getCached5dTrend)에 있으면 비용 0으로 그대로
  // 쓰고, 없으면(예열이 아직 못 돈 종목) 라이브로 새로 조회할 대상으로 분류한다.
  const universeExtraStockTrends: Array<{ stock: any; trendRes: any; programDaily: ProgramTradeDailyPoint[] }> = [];
  const universeExtraNeedsLiveFetch: any[] = [];
  for (const stock of dbFilteredUniverse) {
    const cachedTrend = getCached5dTrend(stock.symbol);
    if (!cachedTrend || !cachedTrend.trend || cachedTrend.trend.length === 0) {
      universeExtraNeedsLiveFetch.push(stock);
      continue;
    }
    // programDaily는 프로그램 순매수를 최신순(내림차순)으로 담은 배열이어야 하는데, 캐시된 trend에는
    // 이미 각 일자별 programNetBuyAmt가 병합되어 있으므로(executeKisInvestorTrendFetch 참고) 그대로 재구성한다.
    const programDailyFromCache: ProgramTradeDailyPoint[] = [...cachedTrend.trend]
      .reverse()
      .map((d: any) => ({
        date: d.stck_bsop_date || d.date || '',
        totalNetBuyAmt: d.programNetBuyAmt || 0,
        totalNetBuyQty: 0,
        volume: d.volume || 0,
      }));
    universeExtraStockTrends.push({ stock, trendRes: cachedTrend, programDaily: programDailyFromCache });
  }

  if (restCandidates.length === 0 && universeExtraNeedsLiveFetch.length === 0) {
    // 후보가 PRIORITY_LIMIT 이하고 DB 사전필터 생존 종목도 전부 캐시로 커버됨 - 기존과 동일하게
    // 한 번에 완전 계산하고 이탈도 즉시 기록
    return finalizeConsecutiveOverlapResult(
      [...priorityResults, ...universeExtraStockTrends],
      targetDays, minOverlap, direction, market, cacheKey, todayStr, prevActive,
      true, false
    );
  }

  // 1단계: 우선순위 후보(+캐시로 이미 확보된 universeExtra)만으로 빠르게 응답 - 이탈 추적 기록은
  // 하지 않는다(아직 못 본 나머지 후보를 "이탈"로 오판하는 걸 막기 위함, writeDropouts=false).
  const partialMasterData = await finalizeConsecutiveOverlapResult(
    [...priorityResults, ...universeExtraStockTrends],
    targetDays, minOverlap, direction, market, cacheKey, todayStr, prevActive,
    false, true
  );

  // 2단계: 응답을 이미 보낸 뒤(await 하지 않음) 나머지 후보 + DB 사전필터로 좁혀진 universeExtra
  // 생존종목(캐시 미보유분)을 이어서 라이브로 조회해 캐시를 완전판으로 덮어쓰고, 이때만 이탈을 기록한다.
  // 실패해도 이번 요청 응답에는 영향 없음(다음 요청이 다시 시도).
  //
  // 🚨 [Vercel 버그 수정] 예전엔 그냥 await 없는 IIFE였다 - 로컬(next dev)은 Node 프로세스가 계속 살아있어
  // 항상 끝까지 완료됐지만, Vercel 서버리스는 응답을 보내는 즉시 함수 컨테이너를 죽여버려서 이 백그라운드
  // 완성 단계가 중간에 잘려나갔다(실측: 버셀에서 계속 "우선순위 15종목"짜리 반쪽 결과에 머물러 있었고,
  // 로컬과 결과가 달랐던 근본 원인). Next.js의 after()(라우트 파일에서 이미 크레딧/배치예열에 쓰던 것과
  // 동일한 패턴)로 등록하면 Vercel이 이 작업이 끝날 때까지(라우트의 maxDuration 내에서) 함수를 살려둔다.
  const backgroundCompletion = async () => {
    try {
      const restResults = await Promise.all(restCandidates.map(fetchTrendPair));
      const universeExtraLiveResults = await Promise.all(universeExtraNeedsLiveFetch.map(fetchTrendPair));
      const fullStockTrends = [...priorityResults, ...restResults, ...universeExtraStockTrends, ...universeExtraLiveResults];
      await finalizeConsecutiveOverlapResult(
        fullStockTrends,
        targetDays, minOverlap, direction, market, cacheKey, todayStr, prevActive,
        true, false
      );
    } catch (e: any) {
      console.warn('[Consecutive Overlap Background Completion Failed]', e?.message || e);
    } finally {
      // 🚨 [버그 수정] 이 cacheKey의 백그라운드 완성 작업이 끝났으니(성공/실패 무관) 가드를 해제해서,
      // 다음 요청이 들어오면 그때는 새로 완전판을 다시 계산할 수 있게 한다.
      consecutiveOverlapBackgroundInFlight.delete(cacheKey);
    }
  };

  // 🚨 [버그 수정] 같은 cacheKey에 대해 이미 백그라운드 완전판 계산이 진행 중이면 또 하나 더 띄우지 않는다.
  // TTL을 180초로 늘려도 서버 재시작 직후 콜드스타트처럼 극단적으로 오래 걸리는 경우, 이 가드가 없으면
  // 여전히 요청마다 새 완성 작업이 겹쳐서 쌓이며 같은 kisQueue를 서로 잡아먹어 아무 것도 제때 못 끝나는
  // 문제가 재발한다 - TTL 연장과 이 가드 두 가지를 함께 적용해야 완전히 막힌다.
  if (consecutiveOverlapBackgroundInFlight.get(cacheKey)) {
    console.log(`[Consecutive Overlap Background Skip] cacheKey=${cacheKey} - 이미 진행 중인 완전판 계산이 있어 중복 실행을 건너뜁니다.`);
  } else {
    consecutiveOverlapBackgroundInFlight.set(cacheKey, true);
    try {
      // Next.js Route Handler 요청 컨텍스트 밖(스크립트에서 직접 호출 등)에서는 after()가 던질 수 있으니
      // 안전하게 폴백해서 예전과 동일한 fire-and-forget으로라도 동작하게 한다.
      const { after } = await import('next/server');
      after(backgroundCompletion);
    } catch (_) {
      backgroundCompletion();
    }
  }

  return partialMasterData;
}

/**
 * "이탈 종목" 탭 전용: 오늘 하루 동안 2일연속/3일연속 교집합 명단에서 밀려난 종목과 그 사유를 조회한다.
 */
export async function fetchConsecutiveOverlapDropouts(
  direction: RankingDirection = 'buy',
  market: MarketType = 'ALL',
  targetDays: number = 2
): Promise<Array<{
  symbol: string;
  name: string;
  reason: string;
  reasonBadges: Array<{ type: string; label: string; detail: string }>;
  netBuyAmtEok?: number;
  ranksByType?: OverlapInvestorRank[];
  currentPrice?: number;
  netBuyQty?: number;
  netBuyAmt?: number;
  changeRate?: number;
  droppedAt?: string;
}>> {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstDate = new Date(utc + 9 * 60 * 60000);
  const todayStr = `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;

  // date=todayStr로 조회하므로 오늘 이탈한(=오늘 저장된) 종목만 반환된다.
  const rows = await fetchConsecutiveOverlapWatch(todayStr, targetDays, direction, market, 'dropped');
  return rows
    .map((r) => {
      // ranks_by_type(jsonb)에는 { ranks, currentPrice, netBuyQty, netBuyAmt, changeRate, reasonBadges } 형태로 저장돼 있다.
      const snapshot = (r.ranksByType as any) || {};
      return {
        symbol: r.symbol,
        name: r.name,
        reason: r.dropReason || '이탈',
        reasonBadges: (snapshot.reasonBadges as Array<{ type: string; label: string; detail: string }>) || [],
        netBuyAmtEok: r.netBuyAmtEok,
        ranksByType: snapshot.ranks as OverlapInvestorRank[] | undefined,
        currentPrice: snapshot.currentPrice,
        netBuyQty: snapshot.netBuyQty,
        netBuyAmt: snapshot.netBuyAmt,
        changeRate: snapshot.changeRate,
        droppedAt: r.droppedAt,
      };
    })
    .sort((a, b) => new Date(b.droppedAt || 0).getTime() - new Date(a.droppedAt || 0).getTime());
}

/**
 * "이탈 종목" 탭 전용(어제의 이탈): 직전 영업일 마감 시점의 2일연속/3일연속 활성 명단과 "지금 이 순간"의
 * 활성 명단을 직접 비교한다. "당일 이탈"(fetchConsecutiveOverlapDropouts)이 오늘 하루 안의 변화만 보는
 * 것과 달리, 히스토리 페이지(calculateOverlapDropoutsFromHistory)와 동일한 "직전 영업일 대비" 기준이라
 * 로컬과 히스토리가 같은 개념을 보여준다.
 */
export async function fetchYesterdayOverlapDropouts(
  direction: RankingDirection = 'buy',
  market: MarketType = 'ALL',
  targetDays: number = 2
): Promise<Array<{
  symbol: string;
  name: string;
  reason: string;
  netBuyAmtEok?: number;
  netBuyAmt?: number;
  currentPrice?: number;
  changeRate?: number;
  comparedDate: string;
}>> {
  const todayStr = getKstTodayStr();
  const yesterdayActive = await fetchLatestActiveBeforeDate(todayStr, targetDays, direction, market).catch(() => []);
  if (yesterdayActive.length === 0) return [];

  const comparedDate = (yesterdayActive[0] as any).date || '';
  const todayActive = await fetchConsecutiveOverlapWatch(todayStr, targetDays, direction, market, 'active').catch(() => []);
  const todaySymbols = new Set(todayActive.map((r) => r.symbol));
  const dropped = yesterdayActive.filter((r) => !todaySymbols.has(r.symbol));
  if (dropped.length === 0) return [];

  const isBuy = direction === 'buy';
  const passesDirection = (amt: number) => (isBuy ? amt > 0 : amt < 0);

  const results = await Promise.all(
    dropped.map(async (item) => {
      const trendRes = await fetchKisInvestorTrend(item.symbol, '5d').catch(() => null);
      const programDaily = await fetchKisProgramTradeDaily(item.symbol).catch(() => []);
      const latestTrend = trendRes?.trend && trendRes.trend.length > 0 ? trendRes.trend[trendRes.trend.length - 1] : null;

      const broken: string[] = [];
      if (!latestTrend || !passesDirection(latestTrend.foreignNetBuyAmt || 0)) broken.push('외국인');
      if (!latestTrend || !passesDirection(latestTrend.organNetBuyAmt || 0)) broken.push('기관');
      if (!passesDirection(programDaily[0]?.totalNetBuyAmt || 0)) broken.push('프로그램');
      const reason = broken.length > 0 ? `${broken.join('·')} 동시매수 조건 이탈` : '동시매수 주체 수 부족';

      const priceInfo = resolveStockPriceAndChange(item.symbol, latestTrend?.closePrice || 0, 0, 0);

      return {
        symbol: item.symbol,
        name: item.name,
        reason,
        netBuyAmtEok: item.netBuyAmtEok,
        netBuyAmt: Math.round((item.netBuyAmtEok || 0) * 100),
        currentPrice: priceInfo.currentPrice,
        changeRate: priceInfo.changeRate,
        comparedDate,
      };
    })
  );

  return results;
}

const surgingCacheStore = getGlobalMap<string, InvestorRankingResponse>('surgingCacheStore');

export async function fetchKisSurgingStocks(
  mode: SurgingMode = 'fluctuation',
  market: MarketType = 'ALL',
  minOverlap: number = 2
): Promise<InvestorRankingResponse> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;

  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  if (mode === 'overlap') {
    return fetchKisSurgingOverlap(market, minOverlap);
  }

  if (mode === 'comprehensive') {
    return fetchKisComprehensiveScoreRanking(market);
  }

  if (mode === 'postmarket') {
    return fetchKisPostMarketCandidates(market);
  }

  const cacheKey = `surging-${mode}-${market}`;

  // 1. In-Memory Cache Check (0ms latency)
  if (surgingCacheStore.has(cacheKey)) {
    const cached = surgingCacheStore.get(cacheKey)!;
    if (Date.now() - new Date(cached.updatedAt).getTime() < 60000) {
      return cached;
    }
  }

  // 🚨 [모바일 콜드스타트 지연 수정] 수급교집합과 동일한 Supabase "완전판"(full:) 캐시 폴백 -
  // 급등주는 surgingCacheStore 인메모리 캐시(60초 TTL)뿐이라 콜드 인스턴스마다 KIS 라이브 API를
  // 재호출해 실측 3.7~5.5초, 이를 3중 호출하는 단타종합(comprehensive)은 37초까지 걸렸다
  // (scratch/diagnose_mobile_tab_speed.js 프로덕션 실측). foreign/organ과 동일 패턴 적용.
  // 🚨 [버그 수정 - 근본 원인] maxAge를 24시간으로 뒀었는데, 급등주는 위 인메모리 캐시와 똑같이 "60초마다
  // 실시간 반영"이 의도된 데이터라 24시간짜리 스냅샷이 계속 재사용되면 사실상 갱신이 멈출 수 있는
  // 잠재 결함이었다("어제랑 똑같아 보인다"는 사용자 의심으로 발견).
  // 🚨 [2차 재발 - 버그 수정] 그래서 인메모리와 똑같이 60초로 맞췄었는데, 이게 3479~3485번 줄의 2일/3일
  // 연속 교집합에서 이미 한 번 겪었던 것과 동일한 설계 실수였다 - "이 프로세스의 재계산 주기"(로컬 TTL)와
  // "다른 인스턴스/환경의 공유 캐시를 얼마나 오래 믿을지"(Supabase 폴백 유효기간)는 다른 질문인데 같은
  // 값으로 묶었다. 60초는 트래픽이 뜸한 환경(사용자 로컬 개발 서버 등)에서는 "누군가 60초 이내에 이미
  // 계산해뒀을" 확률이 거의 0이라 매번 라이브 재계산을 그대로 겪는다(실측: 급등주 교집합(overlap, 내부적
  // 으로 이 함수를 3번 호출)이 사용자 로컬에서 106초). 그래서 한때 5분 고정값으로 절충했었다.
  // 🚨 [3차 재발 - 버그 수정 - 사용자 지적: "모바일 급등주 교집합 왜 또 로딩 긴데. 지금은 장도 다
  // 끝낫구만"] 5분 고정값은 장중 트래픽 희소 환경만 감안했지, 장마감 후(트래픽 자체가 뜸해짐) 5분마다
  // 콜드스타트가 반복되는 건 못 막았다. 장마감 후엔 등락률/거래량/거래대금 자체가 더 이상 안 바뀌니
  // 5분보다 훨씬 길게 캐시해도 무방하다 - fetchKisForeignInstitutionRanking과 동일하게
  // getSharedCacheMaxAgeMs()(장중 60초/장마감 후 다음 마감 경계까지)로 통일한다(수칙 1-6).
  const sharedMap = await fetchSharedRankCacheBatch([`full:${cacheKey}`], getSharedCacheMaxAgeMs()).catch(() => new Map<string, any[]>());
  const sharedList = sharedMap.get(`full:${cacheKey}`);
  if (sharedList && sharedList.length > 0) {
    console.log(`[Shared Rank Cache Hit] full:${cacheKey} - 다른 인스턴스가 이미 계산해둔 급등주(${mode}) 랭킹을 Supabase에서 재사용`);
    const sharedRes: InvestorRankingResponse = {
      type: 'surging',
      direction: 'buy',
      period: '1d',
      list: sharedList,
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
    surgingCacheStore.set(cacheKey, sharedRes);
    return sharedRes;
  }

  try {
    const res = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisSurgingStocksFetch(mode, market), 3, 300),
      'NORMAL',
      cacheKey
    );
    if (res && res.list && res.list.length > 0) {
      surgingCacheStore.set(cacheKey, res);
      syncSharedRankCache(cacheKey, res.list);
      // 뱃지 요약 경량본과 별개로 완전한 RankingItem 전체를 'full:' 접두사에 저장(콜드스타트 읽기 폴백용).
      upsertSharedRankCache(`full:${cacheKey}`, res.list).catch(() => {});
    }
    return res;
  } catch (err: any) {
    console.error(`[KIS Surging Queue Exception] ${mode}-${market}:`, err);
    if (surgingCacheStore.has(cacheKey)) {
      console.warn(`[KIS Surging Stale Cache Fallback] ${cacheKey} 마감/성공 실데이터 캐시 반환`);
      const cached = surgingCacheStore.get(cacheKey)!;
      return {
        ...cached,
        lastBatchTime: '장 마감 - 최근 마감 데이터 기준',
        updatedAt: new Date().toISOString(),
      };
    }

    // Cold startup fallback - return empty list instead of fake seed items
    // 🚨 [버그 수정 - 수칙 1-6] 위 executeAsyncOverlapCalculation의 에러 폴백과 동일한 KST 변환 누락.
    const dateObj = new Date();
    const kstErrDate = new Date(dateObj.getTime() + dateObj.getTimezoneOffset() * 60000 + 9 * 60 * 60000);
    const hours = String(kstErrDate.getHours()).padStart(2, '0');
    const minutes = String(kstErrDate.getMinutes()).padStart(2, '0');

    const emptyRes: InvestorRankingResponse = {
      type: 'surging',
      direction: 'buy',
      period: '1d',
      list: [],
      error: `[KIS Surging Queue Exception] ${err?.message || err}`,
      isMock: false,
      lastBatchTime: `${hours}:${minutes} 기준`,
      updatedAt: dateObj.toISOString(),
    };

    assertNoMockLeak(emptyRes);
    return emptyRes;
  }
}

async function executeKisSurgingStocksFetch(
  mode: SurgingMode,
  market: MarketType
): Promise<InvestorRankingResponse> {
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;

  const token = await getKisAccessToken();
  if (!token) {
    const detail = globalThis.__lastKisOAuthError__ || 'KIS 오픈API Access Token 발급 실패 (인증키 설정 및 KIS 서버 거부 상태 확인 필요)';
    throw new Error(`[KIS API 인증 오류] ${detail}`);
  }

  const iscdParam = market === 'KOSPI' ? '0001' : market === 'KOSDAQ' ? '1001' : '0000';
  let trId = '';
  const rawOutputs: any[] = [];

  if (mode === 'fluctuation') {
    trId = 'FHPST01700000';
  } else {
    trId = 'FHPST01710000';
  }

  const fetchOptions = (urlStr: string, tr: string) => ({
    method: 'GET' as const,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: tr,
      custtype: 'P',
    },
    cache: 'no-store' as const,
    signal: AbortSignal.timeout(8000),
  });

  const getUrl = (iscd: string) => {
    if (mode === 'fluctuation') {
      return `${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=${iscd}&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
    } else {
      const blngCode = mode === 'amount' ? '3' : '0';
      return `${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=${iscd}&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=${blngCode}&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_INPUT_CNT_1=0`;
    }
  };

  await enforceRateLimit();
  if (market === 'ALL') {
    const [resK, resQ] = await Promise.all([
      fetch(getUrl('0001'), fetchOptions(getUrl('0001'), trId)).catch((e) => {
        console.error('💥 [Surging KOSPI fetch error]:', e);
        return null;
      }),
      fetch(getUrl('1001'), fetchOptions(getUrl('1001'), trId)).catch((e) => {
        console.error('💥 [Surging KOSDAQ fetch error]:', e);
        return null;
      }),
    ]);
    const jsonK = resK ? await resK.json().catch(() => null) : null;
    const jsonQ = resQ ? await resQ.json().catch(() => null) : null;
    console.log(`[Surging ALL TR Result] KOSPI rt_cd: ${jsonK?.rt_cd}, len: ${jsonK?.output?.length || 0} | KOSDAQ rt_cd: ${jsonQ?.rt_cd}, len: ${jsonQ?.output?.length || 0}`);
    const listK = jsonK && jsonK.rt_cd === '0' && Array.isArray(jsonK.output) ? jsonK.output : [];
    const listQ = jsonQ && jsonQ.rt_cd === '0' && Array.isArray(jsonQ.output) ? jsonQ.output : [];
    rawOutputs.push(...listK, ...listQ);
  } else {
    const iscd = market === 'KOSPI' ? '0001' : '1001';
    const res = await fetch(getUrl(iscd), fetchOptions(getUrl(iscd), trId)).catch((e) => {
      console.error('💥 [Surging Market fetch error]:', e);
      return null;
    });
    const json = res ? await res.json().catch(() => null) : null;
    console.log(`[Surging Single TR Result] ${market} rt_cd: ${json?.rt_cd}, len: ${json?.output?.length || 0}`);
    if (json && json.rt_cd === '0' && Array.isArray(json.output)) {
      rawOutputs.push(...json.output);
    }
  }

  if (rawOutputs.length === 0) {
    throw new Error('[KIS API 급등주 응답 오류] 수신된 종목 데이터가 없습니다.');
  }

  const itemMap = new Map<string, RankingItem>();

  rawOutputs.forEach((item: any) => {
    const symbol = item.stck_shrn_iscd || item.mksc_shrn_iscd || '';
    if (!symbol || itemMap.has(symbol)) return;

    const rawName = item.hts_kor_isnm || '';
    const name = getStockName(symbol, rawName);
    if (symbol && rawName) registerRuntimeStockName(symbol, rawName);

    const currentPrice = parseInt(item.stck_prpr || '0', 10);
    const sign = item.prdy_vrss_sign || '3';
    let change = parseInt(item.prdy_vrss || '0', 10);
    if (sign === '4' || sign === '5') change = -Math.abs(change);
    const changeRate = parseFloat(item.prdy_ctrt || '0');
    const volume = parseInt(item.acml_vol || '0', 10);

    let amountEok = 0;
    if (item.acml_tr_pbmn) {
      amountEok = Number((parseInt(item.acml_tr_pbmn, 10) / 100000000).toFixed(1));
    } else {
      amountEok = Number(((currentPrice * volume) / 100000000).toFixed(1));
    }

    const volumeIncreaseRate = parseFloat(item.vol_inrt || item.lwpr_vrss_prpr_rate || '0');

    itemMap.set(symbol, {
      rank: 0,
      symbol,
      name,
      currentPrice,
      change,
      changeRate,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume,
      ratioVsVolume: 0,
      amountEok,
      volumeIncreaseRate,
      surgingMode: mode,
      isCreditAvailable: getEvaluatedCreditStatus(symbol, name),
      type: 'surging',
    });
  });

  const items = Array.from(itemMap.values());

  // Explicit numeric descending sort according to surging mode
  if (mode === 'fluctuation') {
    items.sort((a, b) => b.changeRate - a.changeRate);
  } else if (mode === 'volume') {
    items.sort((a, b) => b.volume - a.volume);
  } else if (mode === 'amount') {
    items.sort((a, b) => (b.amountEok || 0) - (a.amountEok || 0));
  }

  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  // 1. Immediately apply cached credit status to eliminate 12s auto-refresh flicker
  // 🚨 [버그 수정 - 근본 원인] 이 호출에 await가 빠져 있었다 - Supabase 배치 조회(fetchCreditBatchFromSupabase,
  // 통상 수십~백여 ms)가 끝나기도 전에 바로 아래 2단계가 실행되면서, DB에 이미 있는 종목까지 전부
  // "아직 캐시에 없음"으로 오판해 kisQueue(LOW)로 KIS 개별 재조회를 걸었다(실측: 급등주 탭 하나만
  // 열어도 신용조회 kisQueue 작업이 100개 이상 한꺼번에 쌓임 - 사용자가 보고한 "수급교집합/종목검색이
  // 안 뜨거나 무한로딩"의 근본 원인 중 하나). await를 붙여 DB 조회 결과가 먼저 캐시에 반영되게 하면,
  // 2단계는 DB에도 정말 없는 신규/누락 종목만 걸러 KIS를 때우므로 불필요한 재조회가 사라진다.
  const mergedList = await mergeCreditStatusToRanking(items);

  // 2. Populate credit status asynchronously in background ONLY for un-cached items (Non-blocking) -
  // 🚨 [버그 수정 - 코드 리뷰 발견] 이 Promise.all은 await하지 않으므로 KIS 응답이 도착하기 전에
  // 아래로 실행이 진행된다 - 예전엔 그 직후 "3. 갱신된 캐시값으로 최종 병합"이라며
  // mergeCreditStatusToRanking(items)를 한 번 더 호출했는데, 이 시점엔 아직 위 1단계와 캐시 상태가
  // 100% 동일하므로(백그라운드 KIS 호출이 끝날 시간적 여유가 전혀 없음) 그 "최종 병합"은 실제로
  // 갱신된 값을 절대 반영할 수 없었고, missingSymbols에 대해 Supabase만 똑같이 한 번 더 조회하는
  // 순수 낭비였다. 이 요청의 응답에는 원래도 반영 불가능했던 갱신값이므로, 1단계 결과를 그대로 쓴다
  // (다음 요청부터는 이 백그라운드 결과가 creditStatusCache에 남아 자연스럽게 반영된다).
  Promise.all(
    items.map(async (item) => {
      if (!creditStatusCache.has(item.symbol)) {
        try {
          await fetchKisCreditAvailable(item.symbol);
        } catch (e) {
          // Keep default
        }
      }
    })
  ).catch(() => { });

  return {
    type: 'surging',
    direction: 'buy',
    period: '1d',
    list: mergedList,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };
}

// 🎯 [기능 추가 - 사용자 요청: "셀렉터까지 원해"] 등락률(3%+)·거래량·거래대금 3개 중 몇 개 이상
// 겹쳐야 교집합으로 볼지 화면에서 고를 수 있게 파라미터화했다. 기존 동작(2개 이상)을 기본값으로 둬서
// "처음 열릴 때는 기존 상태 유지"를 만족한다.
export async function fetchKisSurgingOverlap(
  market: MarketType = 'ALL',
  minOverlap: number = 2
): Promise<InvestorRankingResponse> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;

  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  try {
    const [flucRes, volRes, amtRes, foreignRes, organRes] = await Promise.all([
      fetchKisSurgingStocks('fluctuation', market),
      fetchKisSurgingStocks('volume', market),
      fetchKisSurgingStocks('amount', market),
      fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', market),
      fetchKisForeignInstitutionRanking('organ', 'buy', '1d', market),
    ]);

    const stockMap = new Map<string, any>();

    flucRes.list.forEach((item) => {
      // Only include in fluctuation mode if changeRate >= 3.0% (surging threshold)
      if (item.changeRate >= 3.0) {
        stockMap.set(item.symbol, {
          ...item,
          modes: ['fluctuation'],
        });
      }
    });

    volRes.list.forEach((item) => {
      if (stockMap.has(item.symbol)) {
        const existing = stockMap.get(item.symbol);
        existing.modes.push('volume');
        if (item.volume > (existing.volume || 0)) existing.volume = item.volume;
      } else {
        stockMap.set(item.symbol, {
          ...item,
          modes: ['volume'],
        });
      }
    });

    amtRes.list.forEach((item) => {
      if (stockMap.has(item.symbol)) {
        const existing = stockMap.get(item.symbol);
        existing.modes.push('amount');
        if ((item.amountEok || 0) > (existing.amountEok || 0)) existing.amountEok = item.amountEok;
      } else {
        stockMap.set(item.symbol, {
          ...item,
          modes: ['amount'],
        });
      }
    });

    const flucMap = new Map(flucRes.list.map((s, idx) => [s.symbol, s.rank || idx + 1]));
    const volMap = new Map(volRes.list.map((s, idx) => [s.symbol, s.rank || idx + 1]));
    const amtMap = new Map(amtRes.list.map((s, idx) => [s.symbol, s.rank || idx + 1]));
    const foreignMap = new Map(foreignRes.list.map((s) => [s.symbol, s]));
    const organMap = new Map(organRes.list.map((s) => [s.symbol, s]));

    const list: RankingItem[] = [];

    stockMap.forEach((entry) => {
      const modes: string[] = entry.modes;
      if (modes.length >= minOverlap) {
        const surgingRanks: SurgingRankItem[] = [];
        if (flucMap.has(entry.symbol)) {
          surgingRanks.push({ type: 'fluctuation', label: '등락률', rank: flucMap.get(entry.symbol)! });
        }
        if (volMap.has(entry.symbol)) {
          surgingRanks.push({ type: 'volume', label: '거래량', rank: volMap.get(entry.symbol)! });
        }
        if (amtMap.has(entry.symbol)) {
          surgingRanks.push({ type: 'amount', label: '거래대금', rank: amtMap.get(entry.symbol)! });
        }

        const modeLabels = surgingRanks.map((r) => r.label);
        const surgingBadge = surgingRanks.map((r) => `${r.label} ${r.rank}위`).join(' · ');

        const fItem = foreignMap.get(entry.symbol);
        const oItem = organMap.get(entry.symbol);

        let foreignSupplyBadge = '랭킹 외';
        let foreignSupplyDirection: 'buy' | 'sell' | 'none' = 'none';
        if (fItem) {
          // 🚨 [버그 수정 - 수칙 1-6] `>= 0`은 순매수가 정확히 0인 경우를 "매수"로 오판한다 - 4곳에
          // 동일하게 중복 구현돼 있던 버그. 0은 매수도 매도도 아니므로 'none'(중립, 랭킹 외와 동일하게
          // 방향성 색상 없이 표시)으로 분류한다.
          foreignSupplyDirection = fItem.netBuyAmt > 0 ? 'buy' : fItem.netBuyAmt < 0 ? 'sell' : 'none';
          const sign = fItem.netBuyAmt > 0 ? '+' : '';
          foreignSupplyBadge = `외국인 ${fItem.rank}위 (${sign}${fItem.netBuyAmtEok}억)`;
        }

        let organSupplyBadge = '랭킹 외';
        let organSupplyDirection: 'buy' | 'sell' | 'none' = 'none';
        if (oItem) {
          organSupplyDirection = oItem.netBuyAmt > 0 ? 'buy' : oItem.netBuyAmt < 0 ? 'sell' : 'none';
          const sign = oItem.netBuyAmt > 0 ? '+' : '';
          organSupplyBadge = `기관 ${oItem.rank}위 (${sign}${oItem.netBuyAmtEok}억)`;
        }

        list.push({
          ...entry,
          rank: 0,
          overlapCount: modes.length,
          surgingModes: modeLabels,
          surgingRanks,
          surgingBadge,
          foreignSupplyBadge,
          organSupplyBadge,
          foreignSupplyDirection,
          organSupplyDirection,
          surgingMode: 'overlap',
          type: 'surging',
        });
      }
    });

    list.sort((a, b) => {
      if ((b.overlapCount || 0) !== (a.overlapCount || 0)) {
        return (b.overlapCount || 0) - (a.overlapCount || 0);
      }
      return b.changeRate - a.changeRate;
    });

    list.forEach((item, idx) => {
      item.rank = idx + 1;
      registerRuntimeStockName(item.symbol, item.name);
    });

    const mergedList = await mergeCreditStatusToRanking(list);

    return {
      type: 'surging',
      direction: 'buy',
      period: '1d',
      list: mergedList,
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[KIS Surging Overlap Exception]', err);
    throw err;
  }
}

// 🚨 [기능 추가 - 사용자 요청: "장마감 후보군 탭"] 당일 급등주 교집합(2개 이상) 종목 중, 다음 거래일
// 장 시작 직후 R2 피벗을 넘길 가능성이 상대적으로 높은 후보를 추려낸다. 사용자와 스터디한 기준 3가지를
// 그대로 반영한다:
//   1. 급등주 교집합(등락률·거래량·거래대금 중 2개 이상) - fetchKisSurgingOverlap 재사용(수칙 1-6)
//   2. R2 근접도 - R2 = 종가+(고가-저가) 공식상, 당일 변동폭(고가-저가)/종가 비율이 좁을수록 다음날
//      R2까지 거리가 가깝다. 여기에 종가가 고가권에서 마감했는지(closePositionPct)도 같이 본다 -
//      변동폭이 좁아도 저가 마감이면 매수세가 약했다는 뜻이라 신뢰도가 떨어지기 때문.
//   3. 기관 수급 지속 - investor-trend가 이미 계산해주는 3-상태(STRONG_BUY/BUY/...) 재사용, 새 판정
//      로직을 만들지 않는다.
const postMarketCacheStore = getGlobalMap<string, { data: InvestorRankingResponse; timestamp: number }>('postMarketCacheStore');

/**
 * 후보 종목 배열에 당일 고가/저가/종가 기반 변동폭(todayRangePct)·고가권 마감도(closePositionPct)를
 * 채우고, 교집합 개수(overlapCount) + 고가권 마감 + 변동폭을 합산한 postMarketScore까지 계산해 점수
 * 내림차순으로 정렬·재랭크한다. "장마감 후보군"(급등주 기반, fetchKisPostMarketCandidates) 전용 —
 * 수급교집합 쪽 "장마감 후보만" 토글(applyQuietAccumulationFilter, 아래 4700번 줄 근방)은 별개 로직
 * 이니 다시 통합하지 말 것.
 *
 * 🚨 [공식 수정 - 사용자 요청: "공식을 손보는걸 따로 만들어봐 그래서 결과를 보고 로컬로 옮길지 말지 하자"]
 * 원래 "변동폭 좁을수록 가산점"이었는데, raw_daily_data 100거래일(2026-04-24~09-18, 현재 확보 가능한
 * 전체 기간) 백테스트(scratch/backtest_toggle_conditions_4pct.js, backtest_toggle_formula_variants.js)
 * 로 다음날 고가 +4% 도달률을 직접 측정해보니 정반대였다: 변동폭 좁음(≤10%) 36.6% vs 넓음 56.2%,
 * TOP15 픽 기준 공식 반전 시 44.1%→49.3%(+5.2%p). 100거래일 전체에서 TOP15/TOP30 둘 다 일관되게
 * 개선돼(우연한 부분 구간 효과 아님) "변동폭 넓을수록 가산"으로 반영했다.
 *
 * 🚨 [수정 철회 - 사용자 지적: "기관 매수 우위 자체가 나쁘다는 뜻으로 해석하면 안돼, 한번 더 돌려서
 * 같은 결과가 나오는지 봐봐"] 처음엔 "기관 매수 우위 패널티(-10)"도 같이 반영했는데, 강건성 재검증
 * (scratch/backtest_postmarket_organ_robustness.js)에서 raw_daily_data의 foreign/organ/
 * program_net_buy_amt 세 필드가 2026-04-24~08-06(100거래일 중 75일)엔 전 종목이 예외 없이 0으로
 * 수집되던 데이터 공백 기간이었음을 발견했다 - 그 기간엔 "기관매수 우위" 후보가 정의상 0건이라, 원래
 * 비교(YES 36.7% vs NO 47.6%)는 사실상 "최근 30일(YES) vs 대부분 공백기간을 포함한 100일(NO)"을
 * 비교한 것이었다. 데이터가 실제로 존재하는 구간(08/07~, 29거래일)만으로 다시 보면 YES 36.7% vs NO
 * 34.8%로 방향이 뒤집힌다. 표본이 작아(NO n=423) 이것도 확정적이진 않지만, 최소한 "기관매수 우위가
 * 나쁘다"는 최초 결론은 데이터 공백이 만든 착시였다 - 근거가 사라진 채로 패널티를 유지하는 것도 수칙
 * 1-3 위반이라 이 항목은 점수에서 완전히 뺐다(중립). organStrong 자체는 배지 표시(surgingBadge,
 * 아래)용으로만 계속 쓴다. 표본이 이 기간(변동성 큰 장)에 한정된 결과이므로, 데이터가 더 쌓이면(원본
 * raw_daily_data 자체가 04/24부터 시작이라 지금이 물리적 최대치) 같은 스크립트로 재검증할 것 - 사용자
 * 확정, 임의 튜닝 아님.
 */
async function enrichCandidatesWithNarrowRangeScore<T extends RankingItem>(
  candidates: T[],
  getOrganStrong: (item: T) => boolean
): Promise<T[]> {
  const CHUNK_SIZE = 10;
  const enriched: T[] = [];
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(async (item): Promise<T> => {
        const organStrong = getOrganStrong(item);
        try {
          const price = await fetchKisDailyPrice(item.symbol);
          const h = price?.high || item.currentPrice;
          const l = price?.low || item.currentPrice;
          const c = price?.close || item.currentPrice;
          const range = h - l;
          const todayRangePct = c > 0 ? Number(((range / c) * 100).toFixed(1)) : 0;
          const closePositionPct = range > 0 ? Number((((c - l) / range) * 100).toFixed(0)) : 50;
          return { ...item, todayRangePct, closePositionPct, organStrong } as T;
        } catch (e) {
          console.warn(`[PostMarket Candidate Enrich Skip] ${item.symbol}:`, (e as any)?.message || e);
          // 조회 실패 종목은 배제 신호를 줘서 점수 계산 시 자연스럽게 하위로 밀리게 한다(수칙 1-3 -
          // 실패를 성공인 것처럼 가짜 값으로 채우지 않음). 🚨 [공식 수정에 맞춰 배제값도 반전] 예전엔
          // "변동폭 좁을수록 가산"이라 999(최악)로 배제했는데, 지금은 "변동폭 넓을수록 가산"이라 999를
          // 그대로 두면 실패한 종목이 오히려 만점을 받는다 - 0으로 바꿔야 여전히 최하위로 밀린다.
          return { ...item, todayRangePct: 0, closePositionPct: 0, organStrong } as T;
        }
      })
    );
    enriched.push(...results);
    // KIS 초당 거래건수 제한 여유 확보 - 다른 청크 기반 로직(batchCollector DELAY_MS=50)과 동일 취지
    if (i + CHUNK_SIZE < candidates.length) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  // 종합 점수: 교집합/연속매수 개수(최대 60) + 고가권 마감(최대 30) + 변동폭 넓음(최대 30).
  // 🚨 [수정 철회 - 사용자 지적: "기관 매수 우위 자체가 나쁘다는 뜻으로 해석하면 안돼, 한번 더 돌려서
  // 같은 결과가 나오는지 봐봐"] 처음엔 기관매수 우위에 -10 패널티를 넣었는데, 강건성 재검증
  // (scratch/backtest_postmarket_organ_robustness.js)에서 raw_daily_data의 foreign/organ/
  // program_net_buy_amt 세 필드가 2026-04-24~08-06(전체 100거래일 중 75일)엔 전 종목이 예외 없이
  // 0으로 수집되던 실제 데이터 공백 기간이었음을 발견했다 - 그 기간엔 "기관매수 우위"가 정의상 단 한
  // 건도 없어서(organStrong 후보 n=0), 원래 비교(YES 36.7% vs NO 47.6%)는 사실상 "최근 30일(YES)
  // vs 전체 100일 평균(NO 대부분 공백기간)"을 비교한 것이었다. 데이터가 실제로 존재하는 구간
  // (08/07~, 29거래일)만으로 다시 보면 YES 36.7% vs NO 34.8%로 방향이 뒤집힌다 - 표본이 작아(NO
  // n=423) 이것도 확정적이진 않지만, 최소한 원래의 "기관매수 우위가 나쁘다"는 결론은 데이터 공백이
  // 만든 착시였다. 신뢰할 근거가 없는 채로 페널티를 주는 것도 수칙 1-3 위반이라 이 항목은 점수에서
  // 완전히 뺀다(중립) - organStrong 자체는 배지 표시(surgingBadge, 아래)용으로만 계속 쓴다.
  enriched.forEach((item) => {
    const overlapScore = (item.overlapCount || 2) * 20;
    const closeScore = (item.closePositionPct ?? 50) * 0.3;
    const rangeScore = Math.min(30, item.todayRangePct ?? 0);
    item.postMarketScore = Number((overlapScore + closeScore + rangeScore).toFixed(1));
  });

  enriched.sort((a, b) => (b.postMarketScore || 0) - (a.postMarketScore || 0));
  enriched.forEach((item, idx) => {
    item.rank = idx + 1;
  });
  return enriched;
}

export async function fetchKisPostMarketCandidates(market: MarketType = 'ALL'): Promise<InvestorRankingResponse> {
  const cacheKey = `postmarket-${market}`;
  // 🚨 [버그 수정 - 사용자 지적: "정규장 마감하고나면 바뀌는거 없이 그대로 둬도 되잖아. 매번 로딩할거야?"]
  // 원래 장중이든 장마감 후든 무조건 5분마다 재계산했다 - 당일 고가/저가 기반
  // 지표(enrichCandidatesWithNarrowRangeScore)라 장이 끝나면 그 값이 다음 거래일 재개장 전까지 절대
  // 안 바뀌는데도, 장마감 후 몇 시간이 지나도 5분마다 후보 38종목 전부를 다시 개별 조회했다(종목당 KIS
  // 큐가 200ms 간격으로 직렬 처리돼 실측 7~9초 소요). 이 파일의 다른 모든 랭킹(외국인/기관/급등주)이
  // 이미 쓰는 getSharedCacheMaxAgeMs()(장중 60초/장마감 후엔 다음 재개장 경계까지)를 그대로 재사용한다
  // (수칙 1-6, 새 로직 아님 - 원래 여기만 이 패턴을 안 쓰고 있었다).
  const maxAgeMs = getSharedCacheMaxAgeMs();
  const cached = postMarketCacheStore.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < maxAgeMs) {
    return cached.data;
  }

  const sharedMap = await fetchSharedRankCacheBatch([`full:${cacheKey}`], maxAgeMs).catch(() => new Map<string, any[]>());
  const sharedList = sharedMap.get(`full:${cacheKey}`);
  if (sharedList && sharedList.length > 0) {
    console.log(`[Shared Rank Cache Hit] full:${cacheKey} - 다른 인스턴스가 이미 계산해둔 장마감 후보군을 Supabase에서 재사용`);
    const sharedRes: InvestorRankingResponse = {
      type: 'surging',
      direction: 'buy',
      period: '1d',
      list: sharedList,
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
    postMarketCacheStore.set(cacheKey, { data: sharedRes, timestamp: Date.now() });
    return sharedRes;
  }

  // 1. 급등주 교집합(2개 이상) 후보군 재사용 - 외국인/기관 수급 뱃지까지 이미 계산·신용상태 병합까지 끝난 상태
  const overlapRes = await fetchKisSurgingOverlap(market);
  const candidates = overlapRes.list;

  if (candidates.length === 0) {
    const emptyRes: InvestorRankingResponse = {
      type: 'surging',
      direction: 'buy',
      period: '1d',
      list: [],
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
    postMarketCacheStore.set(cacheKey, { data: emptyRes, timestamp: Date.now() });
    return emptyRes;
  }

  // 2. 후보군만(전 종목이 아님 - 수칙 1-3 KIS 호출 최소화) 청크 단위로 당일 고가/저가를 조회해 변동폭·고가권
  // 마감·기관 매수 우위 종합 점수를 매긴다. "기관 지속매수"는 이미 위 fetchKisSurgingOverlap이 추가 호출
  // 없이 계산해둔 당일 organSupplyDirection(기관 순위표 기준 당일 매수/매도 방향)을 재사용한다 - 여러 날
  // 추세는 못 보지만 이 탭의 원래 목적(다음 거래일 아침 후보 스크리닝)엔 오늘 방향성만으로 충분하고, 새
  // KIS 호출이 전혀 추가되지 않는다(수칙 1-6). 실제 청크 조회·점수 계산은 enrichCandidatesWithNarrowRangeScore
  // (위 4560번 줄 근방) 전용 함수로 위임한다.
  const enriched = await enrichCandidatesWithNarrowRangeScore(candidates, (item) => item.organSupplyDirection === 'buy');

  // 3. 배지 문구에 반영 - 급등주 탭은 이 surgingBadge 문자열이 화면 "급등 상세 순위" 칸에 그대로 노출된다.
  enriched.forEach((item) => {
    const organStrong = Boolean((item as any).organStrong);
    item.surgingBadge = `${item.surgingBadge || ''}${item.surgingBadge ? ' · ' : ''}고가마감 ${item.closePositionPct}% · 변동폭 ${item.todayRangePct}%${organStrong ? ' · 기관매수우위' : ''}`;
    item.surgingMode = 'postmarket';
  });

  const res: InvestorRankingResponse = {
    type: 'surging',
    direction: 'buy',
    period: '1d',
    list: enriched,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };
  postMarketCacheStore.set(cacheKey, { data: res, timestamp: Date.now() });
  // 다른 인스턴스가 재사용할 수 있도록 완전판을 Supabase에 저장(fire-and-forget) - 급등주/외국인/기관과 동일 패턴.
  upsertSharedRankCache(`full:${cacheKey}`, enriched).catch(() => {});
  // 🚨 [기능 추가 - 사용자 요청: "오늘 만든 장마감 후보군도 뱃지모음에 나오게 해줘"] 이 트림 캐시가
  // 없으면 getStockBadgeSummary(뱃지모음)가 이 탭에 뜬 종목을 영원히 찾지 못한다 - 외국인/기관/급등주
  // 3종 등 다른 모든 탭은 처음부터 이 호출을 했는데 postmarket만 빠져 있었다(수칙 1-6 위반이던 것을 발견).
  syncSharedRankCache(cacheKey, enriched);
  return res;
}

// ============================================================================
// 🎯 [기능 추가 - 사용자 요청: "발굴 장마감" 탭] "급등 장마감"(위 fetchKisPostMarketCandidates)은
// 등락률·거래량·거래대금 상위 종목군에서만 후보를 고르다 보니 다음날 결과가 신통치 않다는 실측 피드백을
// 받았다("급등주에서 고르려니까 다음날 결과가 그다지 좋지않은거같아"). 이 함수는 그 랭킹 풀에 의존하지
// 않고 KIS 등락률순위(FHPST01700000)·거래량/거래대금순위(FHPST01710000) 두 TR을 여러 정렬 기준으로
// 반복 호출해 훨씬 넓은 후보군을 모은 뒤(실측: KOSPI+KOSDAQ 합쳐 약 260여 종목 - scratch/
// diagnose_discovery_universe.js), "오늘 얼마나 올랐나"가 아니라 "오르는 과정에서 무엇이 있었나"를
// 5가지 지표로 채점한다:
//   1) absorption   - 상승 중 누가 물량을 받았는지(외국인/기관 장중 추정 순매수)
//   2) afternoon    - 오늘 누적 거래대금 중 14시 이후 비중(매수세가 마감까지 유지됐는지)
//   3) volumeSurge  - 오늘 거래대금 ÷ 최근 20거래일 평균 거래대금(평소 대비 얼마나 몰렸는지)
//   4) pullback     - 당일 고가 등락률 대비 현재 등락률의 하락폭(눌림에도 안 무너졌는지)
//   5) relative     - 현재 등락률 - 소속 시장(KOSPI/KOSDAQ) 지수 등락률(시장 대비 상대강도)
// 장마감 "후"가 아니라 "전"(오후 2시 30분경)에 계산해야 그날 종가 매수 판단에 쓸 수 있다는 사용자
// 요청에 따라, 이 함수는 cron(/api/cron/compute-discovery-postmarket)이 하루 한 번 호출해 결과를
// discovery_snapshots 테이블에 영구 저장하고, 화면(/api/stock/discovery)은 그 저장값만 읽는다 -
// 종목당 최대 4회(투자자동향 추정 1회 + 3분봉 당일 전체 1회(내부적으로 여러 슬롯 병렬) + 최근
// 20거래일 일봉 1회 + 당일 시세 1회) KIS 호출이 필요해 라이브 페이지 요청마다 재계산하기엔 무겁다.
//
// ⚠️ [정직한 한계 고지 - 수칙 1-7] discoveryScore 가중치는 5개 지표를 동일 비중(각 20%)으로 단순
// 평균한 값이다 - "급등 장마감"의 postMarketScore가 실측 백테스트로 선별력이 거의 없다고 판명났던
// 것과 달리, 이 공식은 장마감 "전" 시점 스냅샷이 필요해서 과거 데이터로 미리 검증할 방법이 없다
// (raw_daily_data는 장마감 확정치만 있어 14:30 시점 재현이 불가능하다). discovery_snapshots에
// 매일 쌓이는 실측 결과가 모이면, "급등 장마감"에서 했던 것과 동일한 방식으로 반드시 재검증해야 한다.
// ============================================================================
const DISCOVERY_ENRICH_LIMIT = 40; // 넓은 seed 풀 중 값비싼 종목별 조회 대상으로 삼는 상위 개수(거래대금 기준)
const DISCOVERY_ENRICH_CHUNK_SIZE = 3;
const DISCOVERY_ENRICH_DELAY_MS = 900;
// 🚨 [기능 재설계 - 사용자 지적: "발굴인데 너무 급등한 애들이 1등을 해서 고쳐야 한다고 생각했어. 걔네들은
// 급등으로 빠져야지"] "전조 장마감"이 이미 갖고 있던 하드 필터(PRECURSOR_MAX_TODAY_CHANGE_PCT=8, 아래
// 참고)와 동일 개념(수칙 1-6)을 발굴에도 적용한다 - 전조는 "거의 안 움직인 것"만 남기는 엄격한 기준이라
// 발굴엔 너무 낮으므로, 사용자가 직접 확정한 더 느슨한 값(VI 발동 기준선 근처)을 쓴다. seed 풀 단계
// (거래대금 top-N으로 자르기 전)에서 걸러야, 이미 극단적으로 급등해 거래대금이 가장 큰 종목들이 top-N
// 슬롯을 먼저 차지해 진짜 발굴 후보를 밀어내는 문제까지 함께 해결된다.
const DISCOVERY_MAX_TODAY_CHANGE_PCT = 15; // 오늘 등락률이 이보다 크면 "이미 급등" - 발굴 후보에서 제외(급등 탭에서 보게 됨)

// 🚨 [구조 재설계 - 사용자 지적: "발굴/전조가 이미 급등주 탭에 뜬 종목을 재탕한다"] 실측 확인 결과
// (2026-09-23) 발굴 후보 31개 중 31개(100%) 전부 급등주 탭(등락률/거래량/거래대금 서브모드)에 이미
// 떠 있었다 - 원인은 시드풀이 급등주 탭과 동일한 절대순위 TR(등락률순위 FHPST01700000, 거래량·거래대금
// FID_BLNG_CLS_CODE 0/3)을 그대로 재사용했기 때문이다. 시가총액이 큰 종목은 "안 튀어도" 절대순위
// top-N에 항상 걸려서, "아직 눈에 안 띈 종목 발굴"이라는 원래 취지와 정반대로 동작했다. 절대순위
// 2종(등락률순위 전체, 거래량·거래대금)을 시드에서 완전히 빼고, 그 종목 자체의 평소 대비 상대적
// 이상 징후만 보는 상대순위 2종(거래회전율·평균거래량대비, FID_BLNG_CLS_CODE 1/2)만 남긴다.
/** 거래회전율·평균거래량대비(상대순위)만으로 후보군을 모은다 - 절대순위(등락률/거래량/거래대금)는
 * 급등주 탭과 겹치는 원인이라 시드에서 제외한다(수칙 1-6: 아래 전조 시드풀과 동일 원칙). */
async function fetchKisDiscoverySeedPool(market: MarketType): Promise<RankingItem[]> {
  const iscdList = market === 'KOSPI' ? ['0001'] : market === 'KOSDAQ' ? ['1001'] : ['0001', '1001'];
  const itemMap = new Map<string, RankingItem>();

  const collect = (list: RankingItem[]) => {
    list.forEach((item) => {
      if (!itemMap.has(item.symbol)) itemMap.set(item.symbol, item);
    });
  };

  for (const iscd of iscdList) {
    // FID_BLNG_CLS_CODE: 1=거래회전율, 2=평균거래량대비 - 둘 다 "그 종목 평소 대비" 상대지표라 대형주가
    // 절대치만으로 항상 상위를 차지하는 문제가 없다. 0(거래량)·3(거래대금)은 급등주 탭과 동일한 절대
    // 순위라 제외.
    for (const blngCode of ['1', '2']) {
      await enforceRateLimit();
      const list = await fetchKisDiscoveryRankingSlice('FHPST01710000', iscd, 'FID_BLNG_CLS_CODE', blngCode);
      collect(list);
    }
  }

  return Array.from(itemMap.values()).filter((item) => !isEtfSymbol(item.symbol, item.name));
}

// 🚨 [버그 수정 - 사용자 지적: "그런것들이 더 있나 알아봐"] 기존엔 !res.ok/rt_cd 오류를 재시도 없이
// 조용히 []로 삼켰다 - 이건 발굴 탭의 "후보 풀 자체"를 만드는 단계라, 한 슬라이스만 실패해도 원래
// 후보에 들었어야 할 종목이 애초에 목록에 안 잡힌다(눌림저항/거래대금배율처럼 "-"로라도 보이지 않고
// 완전히 무소식이라 더 안 좋다). fetchWithRetry(최대 3회, 600ms 백오프)로 감싸서 재시도하게 한다.
async function fetchKisDiscoveryRankingSlice(
  trId: 'FHPST01700000' | 'FHPST01710000',
  iscd: string,
  paramKey: 'FID_RANK_SORT_CLS_CODE' | 'FID_BLNG_CLS_CODE',
  paramValue: string
): Promise<RankingItem[]> {
  try {
    return await fetchWithRetry(() => executeKisDiscoveryRankingSliceFetch(trId, iscd, paramKey, paramValue));
  } catch (e) {
    console.warn(`[Discovery Seed Slice Error] ${trId}/${paramKey}=${paramValue}/${iscd}:`, (e as any)?.message || e);
    return [];
  }
}

async function executeKisDiscoveryRankingSliceFetch(
  trId: 'FHPST01700000' | 'FHPST01710000',
  iscd: string,
  paramKey: 'FID_RANK_SORT_CLS_CODE' | 'FID_BLNG_CLS_CODE',
  paramValue: string
): Promise<RankingItem[]> {
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;

  const token = await getKisAccessToken();
  if (!token) return [];

  const url = trId === 'FHPST01700000'
    ? `${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=${iscd}&FID_RANK_SORT_CLS_CODE=${paramKey === 'FID_RANK_SORT_CLS_CODE' ? paramValue : '0'}&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=0&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`
    : `${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=${iscd}&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=${paramKey === 'FID_BLNG_CLS_CODE' ? paramValue : '0'}&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_INPUT_CNT_1=0`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
      custtype: 'P',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`[KIS HTTP Error] Status ${res.status} (discovery-seed ${trId}/${paramKey}=${paramValue}/${iscd})`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`[KIS Parse Error] discovery-seed ${trId}/${iscd}`);
  if (json.rt_cd !== '0') {
    throw new Error(`[KIS rt_cd Error] ${json.msg1 || json.rt_cd} (discovery-seed ${trId}/${paramKey}=${paramValue}/${iscd})`);
  }
  // rt_cd='0'(정상처리)인데 output만 0건인 건 KIS 측 순간 공백 응답일 뿐 API 장애가 아니다(2276행
  // 기존 패턴과 동일) - 에러로 던지지 않고 그냥 빈 배열로 반환한다.
  if (!Array.isArray(json.output)) return [];

  return json.output.map((item: any): RankingItem => {
    const symbol = item.stck_shrn_iscd || item.mksc_shrn_iscd || '';
    const rawName = item.hts_kor_isnm || '';
    const name = getStockName(symbol, rawName);
    if (symbol && rawName) registerRuntimeStockName(symbol, rawName);
    const currentPrice = parseInt(item.stck_prpr || '0', 10);
    const sign = item.prdy_vrss_sign || '3';
    let change = parseInt(item.prdy_vrss || '0', 10);
    if (sign === '4' || sign === '5') change = -Math.abs(change);
    const changeRate = parseFloat(item.prdy_ctrt || '0');
    const volume = parseInt(item.acml_vol || '0', 10);
    const amountEok = item.acml_tr_pbmn
      ? Number((parseInt(item.acml_tr_pbmn, 10) / 100000000).toFixed(1))
      : Number(((currentPrice * volume) / 100000000).toFixed(1));

    return {
      rank: 0,
      symbol,
      name,
      market: resolveMarketType(symbol),
      currentPrice,
      change,
      changeRate,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume,
      ratioVsVolume: 0,
      amountEok,
      type: 'discovery',
    };
  }).filter((item: RankingItem) => item.symbol);
}

/** 종목 하나의 발굴 지표 4종(absorption/afternoon/volumeSurge/pullback)을 계산한다 - relativeStrength는 지수 등락률을 공유해야 해서 호출부에서 더한다. */
async function enrichDiscoveryCandidate(item: RankingItem): Promise<RankingItem> {
  try {
    const [estimate, todayPrice, bars, intraday] = await Promise.all([
      fetchKisInvestorTrendEstimate(item.symbol).catch(() => null),
      fetchKisDailyPrice(item.symbol).catch(() => undefined),
      fetchKisRecentDailyBars(item.symbol).catch(() => undefined),
      fetchKis3mCandlesFullDay(item.symbol).catch(() => null),
    ]);

    // 1) 매집 주체 - 장중 추정치(10:00/11:30/13:20/14:30 중 가장 최신 차수)의 부호로 판정
    let absorptionDirection: 'foreign' | 'organ' | 'both' | 'none' = 'none';
    let absorptionBadge = '데이터 없음';
    if (estimate) {
      const fBuy = estimate.foreignQty > 0;
      const oBuy = estimate.organQty > 0;
      if (fBuy && oBuy) { absorptionDirection = 'both'; absorptionBadge = '외국인+기관 동시 매수'; }
      else if (fBuy) { absorptionDirection = 'foreign'; absorptionBadge = '외국인 매수 우위'; }
      else if (oBuy) { absorptionDirection = 'organ'; absorptionBadge = '기관 매수 우위'; }
      else { absorptionDirection = 'none'; absorptionBadge = '외국인·기관 매도 우위'; }
    }

    // 2) 눌림 저항 - 당일 고가 등락률 대비 현재 등락률 하락폭 (0에 가까울수록 고가권 유지) +
    // "종가가 고가의 90% 이상" 채점용 현재가/고가 비율(%)도 같이 계산(수칙 1-6 - todayPrice 재사용)
    let pullbackFromHighPct: number | undefined;
    let closeToHighRatioPct: number | undefined;
    if (todayPrice && todayPrice.high > 0 && item.currentPrice > 0) {
      closeToHighRatioPct = Number(((item.currentPrice / todayPrice.high) * 100).toFixed(2));
      const prevClose = item.currentPrice / (1 + item.changeRate / 100);
      if (prevClose > 0) {
        const highChangeRate = ((todayPrice.high - prevClose) / prevClose) * 100;
        pullbackFromHighPct = Number((highChangeRate - item.changeRate).toFixed(2));
      }
    }

    // 3) 거래대금/거래량 급증배율 - 오늘(현재까지 누적) ÷ 최근 20거래일(오늘 제외) 평균. bars에 이미
    // amount(거래대금)와 volume(거래량)이 둘 다 있어 추가 KIS 호출 없이 둘 다 계산한다(수칙 1-6).
    let volumeSurgeRatio: number | undefined; // 거래대금 배율
    let rawVolumeSurgeRatio: number | undefined; // 거래량(주식 수) 배율
    // 5) 최근 저점보다 높은 저점 - 최근 5거래일 최저가가 그 이전 5거래일 최저가보다 높으면 상승 저점 패턴
    let higherLowPattern: boolean | undefined;
    let reactivationRatio: number | undefined;
    if (bars && bars.length > 0) {
      const priorBars = bars.filter((b) => b.date !== undefined).slice(-21, -1); // 오늘 제외 최근 20개
      if (priorBars.length >= 10) {
        const avgAmount = priorBars.reduce((sum, b) => sum + b.amount, 0) / priorBars.length;
        const avgVolume = priorBars.reduce((sum, b) => sum + b.volume, 0) / priorBars.length;
        const todayAmount = (item.amountEok || 0) * 100000000;
        if (avgAmount > 0) volumeSurgeRatio = Number((todayAmount / avgAmount).toFixed(2));
        if (avgVolume > 0) rawVolumeSurgeRatio = Number(((item.volume || 0) / avgVolume).toFixed(2));
      }
      const excludingToday = bars.filter((b) => b.date !== undefined).slice(0, -1); // 오늘 제외, 오름차순(과거->최근)
      if (excludingToday.length >= 10) {
        const recentWindow = excludingToday.slice(-5);
        const priorWindow = excludingToday.slice(-10, -5);
        const recentLow = Math.min(...recentWindow.map((b) => b.low));
        const priorLow = Math.min(...priorWindow.map((b) => b.low));
        higherLowPattern = recentLow > priorLow;
      }
      // 6) 재활성화 - 최근 10거래일(오늘 제외) 평균 거래량이 그 이전 10거래일보다 더 조용했는데, 오늘
      // 그 "조용했던 최근" 평균 대비 거래량이 크게 튀었는지("한동안 잠잠하다 갑자기 깨어남" 패턴). 이미
      // 거래가 꾸준히 활발했던 종목(조용해진 적이 없음)은 애초에 "재활성화"라고 부를 게 없으므로 undefined.
      if (excludingToday.length >= 20) {
        const last10 = excludingToday.slice(-10);
        const prior10 = excludingToday.slice(-20, -10);
        const last10AvgVolume = last10.reduce((sum, b) => sum + b.volume, 0) / last10.length;
        const prior10AvgVolume = prior10.reduce((sum, b) => sum + b.volume, 0) / prior10.length;
        const wasQuieter = prior10AvgVolume > 0 && last10AvgVolume < prior10AvgVolume;
        if (wasQuieter && last10AvgVolume > 0) {
          reactivationRatio = Number(((item.volume || 0) / last10AvgVolume).toFixed(2));
        }
      }
    }

    // 4) 오후 매수세 지속 - 오늘 3분봉(현재 시각까지) 중 14시 이후 거래대금 비중
    let afternoonVolumeRatioPct: number | undefined;
    if (intraday && Array.isArray(intraday.candles) && intraday.candles.length > 0) {
      let totalValue = 0;
      let afternoonValue = 0;
      intraday.candles.forEach((c: any) => {
        const barValue = (c.closePrice || 0) * (c.volume || 0);
        totalValue += barValue;
        const hour = parseInt((c.time || '00:00').split(':')[0], 10);
        if (hour >= 14) afternoonValue += barValue;
      });
      if (totalValue > 0) afternoonVolumeRatioPct = Number(((afternoonValue / totalValue) * 100).toFixed(1));
    }

    return {
      ...item,
      absorptionDirection,
      absorptionBadge,
      pullbackFromHighPct,
      closeToHighRatioPct,
      volumeSurgeRatio,
      rawVolumeSurgeRatio,
      higherLowPattern,
      reactivationRatio,
      afternoonVolumeRatioPct,
      foreignAbsorptionQty: estimate?.foreignQty,
      organAbsorptionQty: estimate?.organQty,
    };
  } catch (e) {
    console.warn(`[Discovery Enrich Skip] ${item.symbol}:`, (e as any)?.message || e);
    return item;
  }
}

export async function fetchKisDiscoveryCandidates(market: MarketType = 'ALL'): Promise<InvestorRankingResponse> {
  const dateLabel = getSettledAsOfDateLabel();

  // 1. 넓은 seed 풀 수집 (실측 약 260여 종목 - 등락률/거래량/거래대금 랭킹 의존 없이 여러 정렬 기준 합집합)
  const seedPool = await fetchKisDiscoverySeedPool(market);
  if (seedPool.length === 0) {
    return { type: 'discovery', direction: 'buy', period: '1d', list: [], isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel };
  }

  // 🚨 [기능 재설계 - 사용자 지적: "너무 급등한 애들이 1등을 해서... 걔네들은 급등으로 빠져야지"] 거래대금
  // 상위 N개로 자르기 "전에" 먼저 걸러낸다 - 이미 극단적으로 급등한 종목은 거래대금도 가장 큰 경우가
  // 많아서, top-N 슬라이스 이후에만 걸러내면 그 슬롯을 먼저 차지해 진짜 발굴 후보가 애초에 enrichment
  // 대상에도 못 들어가는 문제가 있었다.
  const beforeSurgeFilterCount = seedPool.length;
  const nonSurgedSeedPool = seedPool.filter((item) => Math.abs(item.changeRate) <= DISCOVERY_MAX_TODAY_CHANGE_PCT);
  console.log(`[발굴 장마감 급등 제외 필터] 오늘 등락률 ±${DISCOVERY_MAX_TODAY_CHANGE_PCT}% 초과 제외: ${beforeSurgeFilterCount}개 -> ${nonSurgedSeedPool.length}개`);

  // 2. 값비싼 종목별 조회는 비용이 커서(종목당 최대 4회 KIS 호출) 거래대금 상위 N개로 제한한다.
  const candidates = [...nonSurgedSeedPool].sort((a, b) => (b.amountEok || 0) - (a.amountEok || 0)).slice(0, DISCOVERY_ENRICH_LIMIT);

  // 3. 시장 지수(KOSPI/KOSDAQ) 등락률 - 종목 전체가 공유하므로 딱 2회만 호출
  const [kospiIdx, kosdaqIdx] = await Promise.all([
    fetchKisIndexDailyTrend('KOSPI', '5d', true).catch(() => null),
    fetchKisIndexDailyTrend('KOSDAQ', '5d', true).catch(() => null),
  ]);
  const indexChangeRate = { KOSPI: kospiIdx?.indexInfo?.changeRate ?? 0, KOSDAQ: kosdaqIdx?.indexInfo?.changeRate ?? 0 };

  // 4. 종목별 지표 계산 - KIS 초당 건수 제한 여유 확보를 위해 청크 단위 처리(다른 청크 기반 로직과 동일 패턴)
  const enriched: RankingItem[] = [];
  for (let i = 0; i < candidates.length; i += DISCOVERY_ENRICH_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + DISCOVERY_ENRICH_CHUNK_SIZE);
    const results = await Promise.all(chunk.map((item) => enrichDiscoveryCandidate(item)));
    results.forEach((item) => {
      const marketKey = (item.market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI') as 'KOSPI' | 'KOSDAQ';
      item.relativeStrengthPct = Number((item.changeRate - indexChangeRate[marketKey]).toFixed(2));
      enriched.push(item);
    });
    if (i + DISCOVERY_ENRICH_CHUNK_SIZE < candidates.length) {
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_ENRICH_DELAY_MS));
    }
  }

  // 5. 수급 필터 - 사용자 요청: "외국인+기관 둘 다 강한 순매도 → 후보에서 제외, 한쪽만 매도 → 후보
  // 유지(점수만 낮아짐), 둘 다 매수 → 정상 고득점". absorptionBadge가 '외국인·기관 매도 우위'인 경우만
  // 정확히 "둘 다 확정적으로 순매도"를 뜻한다(estimate 자체가 없어 '데이터 없음'인 경우는 실패로 인한
  // 결측일 뿐 매도 신호가 아니므로 걸러내지 않는다 - 수칙 1-3, 결측을 나쁜 신호로 오판하지 않음).
  const beforeFilterCount = enriched.length;
  const filtered = enriched.filter((item) => item.absorptionBadge !== '외국인·기관 매도 우위');
  console.log(`[발굴 장마감 수급 필터] 외국인+기관 동시 순매도 제외: ${beforeFilterCount}개 -> ${filtered.length}개`);

  // 6. 종합 점수 - 사용자가 직접 확정한 배점표(합계 100점)를 그대로 절대 점수로 매긴다.
  // 🚨 [기능 재설계 - 사용자 지적: "발굴인데 너무 급등한 애들이 1등을 해서... 미급등성+재활성화"] 기존
  // 8개 조건(거래대금15·거래량5·종가고가10·저점상승15·오후매수세15·상대강도15·외국인12·기관13)을
  // 사용자가 직접 재배점했다: 거래대금 배율(20=거래대금+거래량 합산)·오후 매수세(15)·눌림 저항=종가/
  // 고가(15)·상대강도(10)·외국인·기관 수급(15, 둘을 하나로 합침)·최근 저점 상승(10)·미급등성(10, 신규)·
  // 재활성화(5, 신규) = 100점. 이전엔 후보군 내 백분위 상대평가였는데, 그 방식은 "외국인·기관 매도
  // 우위"인 종목도 다른 지표가 세면 percentile 평균으로 상쇄돼 1위까지 오르는 문제가 실측으로 확인됐다
  // (비츠로테크 사례, 2026-09-18). 절대 점수제는 조건을 못 채우면 그 항목이 0점으로 확실히 깎여서 이
  // 문제가 구조적으로 사라진다. 배율/비율형 조건은 "이상"을 완전히 못 채워도 부분점수를 주는 선형
  // 램프로 구현했다(임계값 코앞에서 0점으로 뚝 떨어지는 절벽 방지) - 값이 시작점 이하면 0점, 목표치
  // 이상이면 만점으로 캡핑한다.
  const ramp = (value: number | undefined, from: number, to: number, maxScore: number): number => {
    if (value === undefined) return 0;
    if (value <= from) return 0;
    if (value >= to) return maxScore;
    return Number((((value - from) / (to - from)) * maxScore).toFixed(2));
  };

  filtered.forEach((item) => {
    // 거래대금 배율(20) - 거래대금(15)·거래량(5)은 상관관계가 높은 사실상 같은 신호라 한 항목으로 합산.
    const amountSurgeScore = ramp(item.volumeSurgeRatio, 1, 3, 15) + ramp(item.rawVolumeSurgeRatio, 1, 3, 5);
    const afternoonScore = ramp(item.afternoonVolumeRatioPct, 23, 40, 15); // 오후 매수세(23%=시간 비례 균등 기준선)
    const closeToHighScore = ramp(item.closeToHighRatioPct, 80, 90, 15); // 눌림 저항 - 종가가 고가의 90% 이상
    const relativeScore = ramp(item.relativeStrengthPct, 0, 5, 10); // 상대강도 - 시장 대비 강함
    // 외국인·기관 수급(15) - absorptionDirection(위 매집 주체 판정과 동일 출처, 수칙 1-6)을 그대로 재사용
    // 해서 둘 다 매수=15, 한쪽만 매수=8(절반 정도), 둘 다 매도(이미 필터에서 제외됨) 또는 데이터 없음=0.
    const supplyScore = item.absorptionDirection === 'both' ? 15 : (item.absorptionDirection === 'foreign' || item.absorptionDirection === 'organ') ? 8 : 0;
    const higherLowScore = item.higherLowPattern ? 10 : 0; // 최근 저점 상승
    // 미급등성(10) - 이미 DISCOVERY_MAX_TODAY_CHANGE_PCT(15%) 초과는 seed 단계에서 걸러졌으므로, 그
    // 기준선에 가까울수록(많이 오를수록) 점수가 깎이고 안 올랐거나(0%) 내린 종목일수록 만점에 가깝다.
    const unSurgedScore = ramp(DISCOVERY_MAX_TODAY_CHANGE_PCT - Math.max(item.changeRate, 0), 0, DISCOVERY_MAX_TODAY_CHANGE_PCT, 10);
    const reactivationScore = ramp(item.reactivationRatio, 2, 5, 5); // 재활성화 - 조용했던 최근 대비 오늘 거래량 배율
    item.discoveryScore = Number((amountSurgeScore + afternoonScore + closeToHighScore + relativeScore + supplyScore + higherLowScore + unSurgedScore + reactivationScore).toFixed(1));
  });

  // 🚨 [구조 재설계 - 사용자 지적: "발굴이 급등 탭 재탕이다"] 시드를 상대순위로 바꿨는데도(위
  // fetchKisDiscoverySeedPool) 실측 73.9%가 여전히 급등주 탭과 겹쳤다(2026-09-23) - 진짜로 튀기
  // 시작한 종목은 상대지표·절대지표 둘 다에서 자연스럽게 잡히기 때문에 시드 소스만으론 한계가 있다.
  // 그래서 후보 생성이 끝난 뒤, 지금 이 순간 급등주 탭(등락률·거래량·거래대금 3서브모드)에 이미 떠
  // 있는 종목을 명시적으로 걸러낸다 - 시드 단계가 아니라 "후보 생성 후" 비교(사용자 지시).
  const beforeSurgingExcludeCount = filtered.length;
  const [surgingFluct, surgingVol, surgingAmt] = await Promise.all([
    fetchKisSurgingStocks('fluctuation', 'ALL').catch(() => null),
    fetchKisSurgingStocks('volume', 'ALL').catch(() => null),
    fetchKisSurgingStocks('amount', 'ALL').catch(() => null),
  ]);
  const surgingSymbols = new Set<string>();
  [surgingFluct, surgingVol, surgingAmt].forEach((res) => {
    (res?.list || []).forEach((item) => surgingSymbols.add(item.symbol));
  });
  const excludedFromSurging = filtered.filter((item) => surgingSymbols.has(item.symbol));
  const afterSurgingExclude = filtered.filter((item) => !surgingSymbols.has(item.symbol));
  console.log(`[발굴 장마감 급등주 탭 중복 제외] ${beforeSurgingExcludeCount}개 -> ${afterSurgingExclude.length}개 (제외 ${excludedFromSurging.length}개: ${excludedFromSurging.map((i) => i.name).join(', ')})`);

  afterSurgingExclude.sort((a, b) => (b.discoveryScore || 0) - (a.discoveryScore || 0));
  afterSurgingExclude.forEach((item, idx) => { item.rank = idx + 1; });

  return {
    type: 'discovery',
    direction: 'buy',
    period: '1d',
    list: afterSurgingExclude,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
  };
}

// ============================================================================
// 🎯 [전면 재정의 - "눌림후속"] 원래 "전조 장마감"은 거래대금급증·증가추세·다이버전스·고가유지 4개
// 지표를 100점 만점으로 채점했으나, 202거래일 실측(scratch/backtest_C_*.js 일련, 2026-09-23)에서
// 그 점수가 다음날 수익률과 상관계수 사실상 0(train r=-0.011, test r=-0.089)으로 확인됐다. 대신
// 원시 차원을 하나씩 독립적으로 뜯어본 결과 "당일 하락(<-0.5%) + 종가/당일고가 94~97%"라는 완전히
// 다른 조합이 train/test 양쪽에서 재현되는 신호로 나왔다(경계값 스윕 검증까지 통과) - 점수 없이 이
// 2개 조건 충족 여부만으로 "눌림후속" 후보를 표시한다.
//
// 🚨 [구조 재설계 - 사용자 지적: "시드풀 완전 제거", 2026-09-23] 상대순위 시드풀(거래회전율·평균
// 거래량대비, FID_BLNG_CLS_CODE 1/2)조차도 "가격 패턴과 무관한 거래량 기준 순위"라 눌림후속 조건
// (순수 가격 패턴)과 안 맞는 종목을 놓친다는 지적에 따라 시드풀 자체를 없앤다. 대신 KIS 관심종목
// (멀티종목) 시세조회(FHKST11300006, intstock-multprice)로 전체 유니버스(stockMasterCache.json
// 3,554개 중 ETF/ETN 제외 실측 2,803종목)를 30종목씩 배치 조회한다.
// 실측 근거(scratch/diagnose_multiquote_and_ratelimit.js, 2026-09-23):
//   - intstock-multprice는 콜당 정확히 30종목까지 응답(35종목 요청해도 30개로 캡, 에러 없음).
//   - 응답 1건에 현재가(inter2_prpr)·고가(inter2_hgpr)·거래량(acml_vol)·거래대금(acml_tr_pbmn)이
//     전부 포함돼 있어, 예전에 필요했던 종목당 2차 호출(enrichPrecursorCandidate/fetchKisDailyPrice)
//     이 통째로 사라진다 - 종목당 2회→배치당 1회로 줄었다.
//   - 이 앱키의 실측 안전 호출 간격은 200ms(초당 5건, 0% 실패) - kisQueue의 minDelayMs와 동일해
//     그대로 재사용한다(수칙 1-6). 2,803종목/30 = 94콜 × 200ms ≈ 19초로 maxDuration=280 대비 여유.
// ============================================================================
const PRECURSOR_BATCH_SIZE = 30;

interface MultiQuoteItem {
  symbol: string;
  name: string;
  currentPrice: number;
  highPrice: number;
  lowPrice: number;
  openPrice: number;
  prevClose: number;
  changeRate: number;
  volume: number;
  amountEok: number;
}

async function executeKisMultiQuoteBatchFetch(symbols: string[]): Promise<MultiQuoteItem[]> {
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;

  const token = await getKisAccessToken();
  if (!token) return [];

  const params = symbols.map((s, i) => `FID_COND_MRKT_DIV_CODE_${i + 1}=J&FID_INPUT_ISCD_${i + 1}=${s}`).join('&');
  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/intstock-multprice?${params}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST11300006',
      custtype: 'P',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`[KIS HTTP Error] Status ${res.status} (multi-quote batch)`);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('[KIS Parse Error] multi-quote batch');
  if (json.rt_cd !== '0') throw new Error(`[KIS rt_cd Error] ${json.msg1 || json.rt_cd} (multi-quote batch)`);
  // 🚨 [버그 수정 - 제 실수] intstock-multprice 실제 응답 필드는 "output1"이 아니라 "output"이다
  // (실측 확인, 2026-09-23: 단발 3종목 호출 raw body에 "output":[...] 로 옴). 첫 진단 스크립트에서
  // output1||output 둘 다 체크해뒀던 걸 여기 옮기며 output1만 남기는 실수를 해서, 전체 유니버스
  // 스캔이 매 배치 조용히 빈 배열을 반환하고 있었다(count:0 오탐 - 조건 미충족이 아니라 파싱 버그).
  if (!Array.isArray(json.output)) return [];

  return json.output
    .map((item: any): MultiQuoteItem | null => {
      const symbol = item.inter_shrn_iscd || '';
      if (!symbol) return null;
      const rawName = item.inter_kor_isnm || '';
      const name = getStockName(symbol, rawName);
      if (rawName) registerRuntimeStockName(symbol, rawName);
      const currentPrice = parseInt(item.inter2_prpr || '0', 10);
      if (currentPrice <= 0) return null;
      const changeRate = parseFloat(item.prdy_ctrt || '0');
      return {
        symbol,
        name,
        currentPrice,
        highPrice: parseInt(item.inter2_hgpr || '0', 10),
        lowPrice: parseInt(item.inter2_lwpr || '0', 10),
        openPrice: parseInt(item.inter2_oprc || '0', 10),
        prevClose: parseInt(item.inter2_prdy_clpr || '0', 10),
        changeRate: isNaN(changeRate) ? 0 : changeRate,
        volume: parseInt(item.acml_vol || '0', 10),
        amountEok: Number((parseInt(item.acml_tr_pbmn || '0', 10) / 100000000).toFixed(1)),
      };
    })
    .filter((item: MultiQuoteItem | null): item is MultiQuoteItem => item !== null);
}

async function fetchKisMultiQuoteBatch(symbols: string[]): Promise<MultiQuoteItem[]> {
  if (symbols.length === 0) return [];
  try {
    return await kisQueue.enqueue(() => fetchWithRetry(() => executeKisMultiQuoteBatchFetch(symbols)), 'NORMAL');
  } catch (e) {
    console.warn(`[Multi Quote Batch Error] ${symbols.length}종목:`, (e as any)?.message || e);
    return [];
  }
}

/**
 * 전체 유니버스(stockMasterCache.json - ETF/ETN 제외)를 30종목씩 관심종목(멀티종목) 시세조회로
 * 훑는다. 시드풀(상대순위) 없이 진짜 전체 종목을 대상으로 한다(사용자 요청: "시드풀 완전 제거").
 */
async function fetchKisFullUniverseQuotes(market: MarketType): Promise<MultiQuoteItem[]> {
  const universe = getMasterStockList().filter(
    (s) => (market === 'ALL' || s.market === market) && !isEtfSymbol(s.symbol, s.name)
  );
  const results: MultiQuoteItem[] = [];
  for (let i = 0; i < universe.length; i += PRECURSOR_BATCH_SIZE) {
    const batch = universe.slice(i, i + PRECURSOR_BATCH_SIZE).map((s) => s.symbol);
    const quotes = await fetchKisMultiQuoteBatch(batch);
    results.push(...quotes);
  }
  return results;
}

export async function fetchKisPrecursorCandidates(market: MarketType = 'ALL'): Promise<InvestorRankingResponse> {
  const dateLabel = getSettledAsOfDateLabel();

  const universeQuotes = await fetchKisFullUniverseQuotes(market);
  if (universeQuotes.length === 0) {
    return { type: 'precursor', direction: 'buy', period: '1d', list: [], isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel };
  }

  // 조건1: 당일 등락률 < -0.5% / 조건2: 종가(현재가)/당일고가 94~97% - 점수 없이 이 2개 조건 충족
  // 여부만으로 "눌림후속" 후보를 가른다(위 202거래일 실측 근거).
  const matched: RankingItem[] = universeQuotes
    .filter((q) => q.changeRate < -0.5 && q.highPrice > 0)
    .map((q) => ({ q, closeToHighRatioPct: Number(((q.currentPrice / q.highPrice) * 100).toFixed(2)) }))
    .filter(({ closeToHighRatioPct }) => closeToHighRatioPct > 94 && closeToHighRatioPct <= 97)
    .map(({ q, closeToHighRatioPct }): RankingItem => ({
      rank: 0,
      symbol: q.symbol,
      name: q.name,
      market: resolveMarketType(q.symbol),
      currentPrice: q.currentPrice,
      change: q.currentPrice - q.prevClose,
      changeRate: q.changeRate,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume: q.volume,
      ratioVsVolume: 0,
      amountEok: q.amountEok,
      openPrice: q.openPrice,
      highPrice: q.highPrice,
      lowPrice: q.lowPrice,
      type: 'precursor',
      closeToHighRatioPct,
    }));

  // 🚨 [구조 재설계 - 사용자 지적: "C의 목적이 이미 시장에 드러난 종목이 아니라 아직 급등 탭에 잡히지
  // 않은 전조 종목을 찾는 것"] 발굴(fetchKisDiscoveryCandidates)과 동일 원인·동일 조치(수칙 1-6) - 시드를
  // 상대순위로 바꿨는데도 실측 33.3%가 여전히 급등주 탭과 겹쳤다(2026-09-23). 후보 생성이 끝난 뒤, 지금
  // 급등주 탭(등락률·거래량·거래대금 3서브모드)에 이미 떠 있는 종목을 명시적으로 걸러낸다.
  const beforeSurgingExcludeCountC = matched.length;
  const [surgingFluctC, surgingVolC, surgingAmtC] = await Promise.all([
    fetchKisSurgingStocks('fluctuation', 'ALL').catch(() => null),
    fetchKisSurgingStocks('volume', 'ALL').catch(() => null),
    fetchKisSurgingStocks('amount', 'ALL').catch(() => null),
  ]);
  const surgingSymbolsC = new Set<string>();
  [surgingFluctC, surgingVolC, surgingAmtC].forEach((res) => {
    (res?.list || []).forEach((item) => surgingSymbolsC.add(item.symbol));
  });
  const excludedFromSurgingC = matched.filter((item) => surgingSymbolsC.has(item.symbol));
  const afterSurgingExcludeC = matched.filter((item) => !surgingSymbolsC.has(item.symbol));
  console.log(`[전조(눌림후속) 급등주 탭 중복 제외] ${beforeSurgingExcludeCountC}개 -> ${afterSurgingExcludeC.length}개 (제외 ${excludedFromSurgingC.length}개: ${excludedFromSurgingC.map((i) => i.name).join(', ')})`);

  // 🎯 [실험 추가 - 사용자 지시: "14:40 크론에 가집계 조회 붙이기", 2026-09-23 1단계] 후보군(보통
  // 수백 개 수준)에 한해서만 가집계 추정치(HHPTJ04160200)를 개별 조회한다 - kisQueue가 이미 200ms
  // 페이싱을 하므로 별도 쓰로틀링 없이 Promise.all로 넘겨도 안전하다(fetchKisRecentDailyBars와 동일
  // 패턴, 수칙 1-6). 실패한 종목은 foreignRatioEstimate가 undefined로 남는다(가짜 0 금지, 수칙 1-3).
  const estimates = await Promise.all(
    afterSurgingExcludeC.map((item) => fetchKisInvestorTrendEstimate(item.symbol).catch(() => null))
  );
  afterSurgingExcludeC.forEach((item, idx) => {
    const est = estimates[idx];
    if (est && item.volume > 0) {
      item.foreignRatioEstimate = Number(((est.foreignQty / item.volume) * 100).toFixed(3));
    }
  });
  const withEstimate = afterSurgingExcludeC.filter((item) => item.foreignRatioEstimate !== undefined);
  const estimateTop20Count = Math.max(1, Math.ceil(withEstimate.length * 0.2));
  const sortedByEstimate = [...withEstimate].sort((a, b) => (b.foreignRatioEstimate || 0) - (a.foreignRatioEstimate || 0));
  const top20Symbols = new Set(sortedByEstimate.slice(0, estimateTop20Count).map((item) => item.symbol));
  // 🎯 [UI 추가 - 사용자 요청: "외국인 순위(%)" 컬럼, 2026-09-23] top20 불리언만으로는 화면에 "상위 몇
  // %"인지 못 보여준다 - 가집계 순매수비율 내림차순 순위를 그대로 백분위로 환산한다(1위=가장 낮은 값
  // =가장 상위, 후보군 크기가 매일 달라도 항상 0~100 범위로 비교 가능).
  const estimateRankBySymbol = new Map(sortedByEstimate.map((item, idx) => [item.symbol, idx + 1]));
  afterSurgingExcludeC.forEach((item) => {
    if (item.foreignRatioEstimate !== undefined) {
      item.foreignRatioEstimateTop20 = top20Symbols.has(item.symbol);
      const rank = estimateRankBySymbol.get(item.symbol)!;
      item.foreignRatioEstimateRankPct = Number(((rank / withEstimate.length) * 100).toFixed(1));
    }
  });
  console.log(`[전조(눌림후속) 가집계 외국인순매수 조회] 후보 ${afterSurgingExcludeC.length}개 중 ${withEstimate.length}개 조회 성공, 상위20%(${estimateTop20Count}개) 플래그 지정`);

  // 점수가 없으므로 당일 하락폭이 큰 순(조건1의 핵심 차원)으로 정렬한다 - 별도 배점 없이 조건 충족
  // 종목을 그대로 보여주는 게 목적이라 "가장 뚜렷하게 하락한 것부터"가 가장 단순한 기본 정렬이다.
  afterSurgingExcludeC.sort((a, b) => a.changeRate - b.changeRate);
  afterSurgingExcludeC.forEach((item, idx) => { item.rank = idx + 1; });

  return {
    type: 'precursor',
    direction: 'buy',
    period: '1d',
    list: afterSurgingExcludeC,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
  };
}

// 🚨 [기능 재설계 - 사용자 요청: "3일연속이 다음날 상승에 더 좋을려나?" → 실측 백테스트 → "다른 조건이면
// 어떤게 더 좋은지 봐봐" → "2일연속/3일연속 풀에서도 확인해봐" → "토글 필터로 진행해줘"] 원래 있던
// "수급 장마감 후보군"(3일연속 전용 4번째 버튼, fetchKisSupplyPostMarketCandidates)을 제거하고, 당일/
// 2일연속/3일연속 어느 탭에서든 켤 수 있는 토글 필터로 바꾼다. 제거 이유는 실측 근거가 있다 - scratch
// 백테스트(2026-04-28~09-11, 96거래일 원본 raw_daily_data 실측)로 옛 공식(변동폭 좁음·고가권 마감·
// 기관매수 가점)의 다음날 수익률을 직접 검증한 결과:
//   - 3일연속 교집합 자체가 당일/2일연속보다 다음날 수익률이 더 나빴다(중앙값 -0.132% vs +0.126%/+0.189%,
//     승률 47.4% vs 51.7%/52.3%) - "3일 연속 매집일수록 더 강한 신호"라는 원래 가정이 틀렸다.
//   - 옛 공식으로 상위 N을 골라낼수록(어느 기준을 쓰든) 오히려 필터 없는 전체 풀보다 더 나빠졌다
//     (예: 3일연속 상위 15위 중앙값 -0.321% - 필터가 있으나 마나가 아니라 역효과).
// 개별 요인 5분위 분석으로 진짜 신호를 찾았다 - 옛 공식과 정반대 방향이다:
//   - 종가위치: 낮을수록(저가마감) 좋음 (Q1 평균+0.856%/승률56.4% vs Q5 평균-0.031%/승률46.3%)
//   - 거래량/최근5일평균: 낮을수록(조용할수록) 좋음 (Q1 평균+0.719%/승률56.1% vs Q5 평균+0.160%/승률46.9%)
//   - 최근5일 누적수익률: 낮을수록(최근 눌려있을수록) 좋음 (Q1 평균+1.343%/승률59.1% vs Q5 평균-0.072%/승률47.5%)
// 세 지표를 후보군 내 백분위로 환산해(낮을수록 고득점) 30%+30%+30% + 주체수(2→3) 10% 가중합한 새 점수로
// 당일/2일연속/3일연속 세 풀 전부에서 Top-N 백테스트 재검증까지 마쳤다(당일·2일연속은 뚜렷한 개선,
// 3일연속은 개선되지만 본전 수준) - applyQuietAccumulationFilter가 이 새 공식이다.
const QUIET_ACCUM_CACHE_TTL_MS = 5 * 60 * 1000; // 당일 캔들·거래량 기반 지표라 급등주(60초)만큼 자주 안 바뀜
const quietAccumCacheStore = getGlobalMap<string, { data: InvestorRankingResponse; timestamp: number }>('quietAccumCacheStore');
const recentDailyBarsCache = getGlobalMap<string, { data: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }>; timestamp: number }>('recentDailyBarsCache');
// 🚨 [성능 수정 - 사용자 지적: "장마감 후보만은 왤케 로딩이 오래걸리는지"] 실측 46.5초 - 원인 두 가지를
// fetchConsecutive3dOverlapRankingData(위 3772번 줄 PRIORITY_LIMIT 근방)가 이미 겪고 고쳐둔 것과
// 동일한 패턴으로 해결한다:
//   1. kisQueue는 완전 직렬(isProcessing 플래그 하나, 매 건 최소 200ms 간격) - 후보를 Promise.all로
//      "동시에" 보내도 전부 같은 큐에서 한 줄로 서서 하나씩 처리된다. 후보 수만큼 그대로 시간이 늘어남.
//   2. raw_daily_data(장마감 후 자동 수집되는 원본 아카이브)에 최근 5거래일치가 이미 다 있는데, 이걸
//      안 쓰고 후보마다 KIS 라이브로 새로 조회했다 - fetchTrendPair(위 3807번 줄)가 이미 쓰는 "DB 우선,
//      부족할 때만 라이브 폴백" 패턴을 그대로 재사용한다(수칙 1-6).
// 해결: (a) 최근 5일치는 Supabase에서 한 번에 일괄 조회해 종목당 라이브 호출을 "오늘 하루치"(이미 있는
// 경량 함수 fetchKisDailyPrice 재사용) 1건으로 줄이고, (b) 그마저도 PRIORITY_LIMIT=15개만 먼저 채워
// 즉시 응답(isPartial:true)하고 나머지는 after()로 백그라운드에서 마저 채운다 - 프론트는 이미 isPartial
// 이면 4초마다 자동 재조회하므로 수정 없이 그대로 체감 속도가 개선된다.
const quietAccumBackgroundInFlight = getGlobalMap<string, boolean>('quietAccumBackgroundInFlight');

/**
 * "장마감 후보만" 토글 전용 - 후보 종목의 최근 6거래일치(오늘 포함) 시가/고가/저가/종가/거래량만 가볍게
 * 조회한다. fetchKisInvestorTrend(365일치+수급+프로그램매매까지 통째 조회)를 후보군 전체에 또 돌리면
 * 느려지는 문제를 fetchKisDailyPrice가 이미 "오늘 시세만"으로 해결했던 것과 동일한 이유로, 여기선
 * inquire-daily-itemchartprice(FHKST03010100)를 짧은 기간(달력 12일 ≈ 거래일 6~8일)만 요청해 오늘
 * 시세뿐 아니라 직전 며칠치 거래량·종가까지 단 1회 호출로 받는다(수칙 1-6 - executeKisInvestorTrendFetch와
 * 같은 TR을 재사용하되 페이지네이션·수급 병합 등 무거운 부분은 걷어냄).
 */
export async function fetchKisRecentDailyBars(
  symbol: string
): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }> | undefined> {
  const cached = recentDailyBarsCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < getDynamicRankingTtl()) {
    return cached.data;
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '') return undefined;

  try {
    const result = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisRecentDailyBarsFetch(symbol)),
      'LOW',
      `recent-daily-bars-${symbol}`
    );
    if (result && result.length > 0) {
      recentDailyBarsCache.set(symbol, { data: result, timestamp: Date.now() });
    }
    return result;
  } catch (e) {
    console.warn(`[Recent Daily Bars Queue Error] ${symbol}:`, e);
    return undefined;
  }
}

async function executeKisRecentDailyBarsFetch(
  symbol: string
): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }> | undefined> {
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;

  const token = await getKisAccessToken();
  if (!token) return undefined;

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startObj = new Date(today);
  // 🚨 [기능 확장 - "발굴 장마감" 20일 평균 거래대금 계산용] 기존엔 -14일(거래일 6~8일)만 받았는데,
  // 실측(scratch)으로 확인한 KRX 거래일 비율(주 5일)상 20거래일을 안전하게 확보하려면 최소 -30일은
  // 필요하다 - 실측: -40일 요청 시 28거래일 확보됨. 기존 5일 lookback(quiet-accum)만 쓰는 호출부는
  // 이 배열에서 필요한 만큼만 슬라이스해 쓰므로(하위 호환), 범위를 넓혀도 부작용이 없다(수칙 1-6).
  startObj.setDate(startObj.getDate() - 40);
  const startDate = startObj.toISOString().slice(0, 10).replace(/-/g, '');

  // 🚨 [버그 수정 - NXT 거래소 누락] 위 dailyChartUrl(942번대)과 동일 TR, 동일 실측 근거로 UN 적용.
  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=UN&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'FHKST03010100',
      custtype: 'P',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });

  // 🚨 [버그 수정 - 사용자 지적: "현대건설, 대한항공의 거래대금 배율은 왜 -로 표시되는거야?"] 기존엔
  // !res.ok(비-200 응답)를 재시도 없이 조용히 undefined로 삼켜서, 배치 도중 KIS 게이트웨이가 일시적으로
  // non-200을 준 종목만 20일 평균 계산에 필요한 일봉을 영영 못 받고 "-"로 남았다(실측: 09/22 14:30
  // 배치에서 현대건설·대한항공 등 대형주 9종목 중복 확인 - 재호출 시 전부 정상 28일치 수신됨, KIS
  // 서버측 순간 오류였음이 확정). 다른 KIS 호출들(747/6125/6629/6687라인)과 동일하게 throw로 바꿔서
  // 이 함수를 감싸는 fetchWithRetry(최대 3회, 600ms 백오프)가 실제로 재시도하게 한다(수칙 1-6).
  if (!res.ok) throw new Error(`[KIS HTTP Error] Status ${res.status} (recent-daily-bars ${symbol})`);
  const json = await res.json().catch(() => null);
  if (!json || json.rt_cd !== '0' || !Array.isArray(json.output2)) {
    throw new Error(`[KIS rt_cd Error] ${json?.rt_cd || 'parse-fail'}: ${json?.msg1 || '응답 파싱 실패'} (recent-daily-bars ${symbol})`);
  }

  return json.output2
    .map((item: any) => ({
      date: item.stck_bsop_date || '',
      open: parseInt(item.stck_oprc || '0', 10),
      high: parseInt(item.stck_hgpr || '0', 10),
      low: parseInt(item.stck_lwpr || '0', 10),
      close: parseInt(item.stck_clpr || '0', 10),
      volume: parseInt(item.acml_vol || '0', 10),
      amount: parseInt(item.acml_tr_pbmn || '0', 10),
    }))
    .filter((b: any) => b.date && b.close > 0)
    .reverse(); // KIS는 최신순(내림차순)으로 내려주므로 오름차순으로 뒤집는다
}

// 종목 하나의 종가위치·거래량배율·5일누적수익률을 계산한다. raw_daily_data(Supabase, 장마감 후 자동
// 수집)에 최근 5거래일치가 이미 다 있으면 "오늘 하루치"만 기존 경량 함수 fetchKisDailyPrice로 보완하고
// (다른 postmarket 기능과 캐시를 공유하므로 중복 라이브 호출도 줄어든다), DB 이력이 부족한 종목(신규
// 상장 등)만 기존 방식(전체 구간 라이브 조회, fetchKisRecentDailyBars)으로 안전하게 폴백한다(수칙 1-6 -
// fetchTrendPair의 "DB 우선, 부족할 때만 라이브" 패턴 재사용).
async function computeQuietAccumFactors<T extends RankingItem>(
  item: T,
  trailingDates: string[],
  trailingBySymbol: Map<string, Map<string, any>>
): Promise<(T & { volRatioPct: number; cum5dReturnPct: number }) | null> {
  const symbolDates = trailingBySymbol.get(item.symbol);
  const hasFullDbHistory = trailingDates.length >= 5 && !!symbolDates && trailingDates.every((d) => symbolDates.has(d));

  if (hasFullDbHistory) {
    try {
      const price = await fetchKisDailyPrice(item.symbol);
      const h = price?.high || item.currentPrice;
      const l = price?.low || item.currentPrice;
      const c = price?.close || item.currentPrice;
      const range = h - l;
      const closePositionPct = range > 0 ? Number((((c - l) / range) * 100).toFixed(0)) : 50;

      const priorVols = trailingDates.map((d) => symbolDates!.get(d)!.volume || 0);
      const avgVol5 = priorVols.reduce((sum, v) => sum + v, 0) / priorVols.length;
      const volRatioPct = avgVol5 > 0 ? Number((((item.volume || 0) / avgVol5) * 100).toFixed(1)) : 100;

      const fiveDaysAgoClose = symbolDates!.get(trailingDates[0])!.close_price || 0;
      const cum5dReturnPct = fiveDaysAgoClose > 0 ? Number((((c - fiveDaysAgoClose) / fiveDaysAgoClose) * 100).toFixed(2)) : 0;

      return { ...item, closePositionPct, volRatioPct, cum5dReturnPct };
    } catch (e) {
      console.warn(`[Quiet Accum DB-Path Enrich Skip] ${item.symbol}:`, (e as any)?.message || e);
      return null;
    }
  }

  // DB 이력 부족 - 폴백: 기존 방식대로 최근 6거래일치를 라이브로 통째 조회
  try {
    const bars = await fetchKisRecentDailyBars(item.symbol);
    if (!bars || bars.length < 6) return null;
    const todayBar = bars[bars.length - 1];
    const prior5 = bars.slice(bars.length - 6, bars.length - 1);
    const fiveDaysAgoBar = bars[bars.length - 6];

    const range = todayBar.high - todayBar.low;
    const closePositionPct = range > 0 ? Number((((todayBar.close - todayBar.low) / range) * 100).toFixed(0)) : 50;
    const avgVol5 = prior5.reduce((sum, b) => sum + b.volume, 0) / prior5.length;
    const volRatioPct = avgVol5 > 0 ? Number(((todayBar.volume / avgVol5) * 100).toFixed(1)) : 100;
    const cum5dReturnPct = fiveDaysAgoBar.close > 0
      ? Number((((todayBar.close - fiveDaysAgoBar.close) / fiveDaysAgoBar.close) * 100).toFixed(2))
      : 0;

    return { ...item, closePositionPct, volRatioPct, cum5dReturnPct };
  } catch (e) {
    console.warn(`[Quiet Accum Fallback Enrich Skip] ${item.symbol}:`, (e as any)?.message || e);
    return null;
  }
}

// 종목 배열을 청크 단위로 순회하며 위 계산을 돌린다 - kisQueue가 어차피 완전 직렬이라 청크 자체가
// 속도를 내주진 않지만(수칙 1-1 실측 확인), 한 번에 너무 많은 Promise를 동시에 살려두지 않기 위해 유지한다.
async function enrichQuietAccumBatch<T extends RankingItem>(
  batch: T[],
  trailingDates: string[],
  trailingBySymbol: Map<string, Map<string, any>>
): Promise<Array<T & { volRatioPct: number; cum5dReturnPct: number }>> {
  const CHUNK_SIZE = 10;
  const out: Array<T & { volRatioPct: number; cum5dReturnPct: number }> = [];
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(chunk.map((item) => computeQuietAccumFactors(item, trailingDates, trailingBySymbol)));
    results.forEach((r) => { if (r) out.push(r); });
  }
  return out;
}

/**
 * "장마감 후보만" 토글 - 위 주석에 정리한 백테스트 검증 공식 그대로: 종가위치·거래량배율·5일누적수익률을
 * 후보군 내 백분위로 환산해(셋 다 낮을수록 고득점) 30%씩, 주체수(2→0점/3→100점) 10%로 가중합한다.
 * 데이터를 못 가져온 종목은 percentile 계산을 왜곡하지 않도록 후보군 자체에서 제외한다(수칙 1-3 -
 * 실패를 가짜 중간값으로 채우지 않음). 순수 계산 함수 - I/O는 호출부에서 이미 끝낸 결과(enrichedRaw)만 받는다.
 */
function scoreQuietAccumCandidates<T extends RankingItem>(
  enrichedRaw: Array<T & { volRatioPct: number; cum5dReturnPct: number }>,
  topLimit: number
): T[] {
  if (enrichedRaw.length === 0) return [];

  // 백분위 환산(오름차순 정렬 후 순위/전체) - 셋 다 "낮을수록" 고득점이라 (100 - percentile)로 뒤집는다
  const percentileOf = (values: number[], target: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    let idx = sorted.findIndex((v) => v >= target);
    if (idx === -1) idx = sorted.length - 1;
    return (idx / sorted.length) * 100;
  };
  const closeVals = enrichedRaw.map((r) => r.closePositionPct ?? 50);
  const volVals = enrichedRaw.map((r) => r.volRatioPct);
  const momVals = enrichedRaw.map((r) => r.cum5dReturnPct);
  const maxOverlap = Math.max(...enrichedRaw.map((r) => r.overlapCount || 2), 3);

  enrichedRaw.forEach((item) => {
    const closeScore = 100 - percentileOf(closeVals, item.closePositionPct ?? 50);
    const volScore = 100 - percentileOf(volVals, item.volRatioPct);
    const momScore = 100 - percentileOf(momVals, item.cum5dReturnPct);
    const overlapScore = maxOverlap > 2 ? (((item.overlapCount || 2) - 2) / (maxOverlap - 2)) * 100 : 0;
    item.postMarketScore = Number((closeScore * 0.3 + volScore * 0.3 + momScore * 0.3 + overlapScore * 0.1).toFixed(1));
  });

  enrichedRaw.sort((a, b) => (b.postMarketScore || 0) - (a.postMarketScore || 0));
  const trimmed = enrichedRaw.slice(0, topLimit);
  trimmed.forEach((item, idx) => { item.rank = idx + 1; });
  return trimmed;
}

export async function fetchKisQuietAccumulationCandidates(
  baseMode: 'daily' | 'consecutive2d' | 'consecutive3d',
  direction: RankingDirection = 'buy',
  market: MarketType = 'ALL',
  topLimit: number = 50
): Promise<InvestorRankingResponse> {
  const cacheKey = `quiet-accum-${baseMode}-${direction}-${market}`;
  const cached = quietAccumCacheStore.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < QUIET_ACCUM_CACHE_TTL_MS) {
    return cached.data;
  }

  const periodLabel = (baseMode === 'consecutive2d' ? 'consecutive2d' : baseMode === 'consecutive3d' ? 'consecutive3d' : '1d') as RankingPeriod;

  const sharedMap = await fetchSharedRankCacheBatch([`full:${cacheKey}`], QUIET_ACCUM_CACHE_TTL_MS).catch(() => new Map<string, any[]>());
  const sharedList = sharedMap.get(`full:${cacheKey}`);
  if (sharedList && sharedList.length > 0) {
    console.log(`[Shared Rank Cache Hit] full:${cacheKey} - 다른 인스턴스가 이미 계산해둔 장마감 후보만 필터 결과를 Supabase에서 재사용`);
    const sharedRes: InvestorRankingResponse = {
      type: 'overlap', direction, period: periodLabel, list: sharedList, isMock: false, updatedAt: new Date().toISOString(),
    };
    quietAccumCacheStore.set(cacheKey, { data: sharedRes, timestamp: Date.now() });
    return sharedRes;
  }

  // 1. 기준 교집합 목록 재사용(당일/2일연속/3일연속 중 프론트가 지금 보고 있는 탭 그대로) - 연속일수
  // 판정·이탈 추적·이격도 배지까지 이미 끝난 상태(수칙 1-6)
  const overlapRes = baseMode === 'consecutive2d'
    ? await fetchConsecutive2dOverlapRankingData(direction, 2, topLimit, market)
    : baseMode === 'consecutive3d'
    ? await fetchConsecutive3dOverlapRankingData(direction, 2, topLimit, market)
    : await fetchOverlapRankingData(direction, '1d', 2, topLimit, market);
  const candidates = overlapRes.list;

  if (candidates.length === 0) {
    const emptyRes: InvestorRankingResponse = { type: 'overlap', direction, period: periodLabel, list: [], isMock: false, updatedAt: new Date().toISOString() };
    quietAccumCacheStore.set(cacheKey, { data: emptyRes, timestamp: Date.now() });
    return emptyRes;
  }

  // 2. 최근 5거래일치를 Supabase에서 후보군 전체에 대해 "한 번에" 일괄 조회한다(종목당 개별 조회 없음) -
  // fetchTrendPair(위 3791번 줄)가 2일/3일연속 계산에서 이미 쓰는 것과 동일한 함수(수칙 1-6).
  const todayStr = getKstTodayStr();
  const { fetchRawDailyTrailingDays } = await import('./supabase');
  const { dates: trailingDates, bySymbol: trailingBySymbol } = await fetchRawDailyTrailingDays(todayStr, 5).catch(
    () => ({ dates: [] as string[], bySymbol: new Map<string, Map<string, any>>() })
  );

  // 3. PRIORITY_LIMIT개만 먼저 채워 즉시 응답(isPartial:true) - fetchConsecutive3dOverlapRankingData의
  // 우선순위 패턴과 동일(위 3772번 줄). candidates는 이미 순매수금액 등 기준으로 정렬돼 있어 "가장 유력한
  // 후보부터" 먼저 보여준다.
  const PRIORITY_LIMIT = 15;
  const priorityCandidates = candidates.slice(0, PRIORITY_LIMIT);
  const restCandidates = candidates.slice(PRIORITY_LIMIT);

  const priorityEnriched = await enrichQuietAccumBatch(priorityCandidates, trailingDates, trailingBySymbol);
  const priorityRanked = scoreQuietAccumCandidates(priorityEnriched, Math.min(20, topLimit));

  const basePartial = overlapRes.isPartial; // 기준 목록 자체가 이미 부분판이면 이번 응답도 당연히 부분판

  if (restCandidates.length === 0 && !basePartial) {
    // 후보가 PRIORITY_LIMIT 이하고 기준 목록도 완전판 - 한 번에 완전 계산 후 캐시
    const res: InvestorRankingResponse = {
      type: 'overlap', direction, period: periodLabel, list: priorityRanked, isPartial: false, isMock: false, updatedAt: new Date().toISOString(),
    };
    quietAccumCacheStore.set(cacheKey, { data: res, timestamp: Date.now() });
    upsertSharedRankCache(`full:${cacheKey}`, priorityRanked).catch(() => {});
    syncSharedRankCache(cacheKey, priorityRanked);
    return res;
  }

  // 4. 우선순위분만으로 즉시 응답(부분판) - 캐시에 박제하지 않는다(프론트가 4초 간격으로 재조회해
  // 완전판이 준비되는 대로 자동 반영한다).
  const partialRes: InvestorRankingResponse = {
    type: 'overlap', direction, period: periodLabel, list: priorityRanked, isPartial: true, isMock: false, updatedAt: new Date().toISOString(),
  };

  // 5. 응답을 보낸 뒤(await 하지 않음) 나머지 후보를 이어서 채워 캐시를 완전판으로 갱신한다 - Vercel
  // 서버리스에서도 끝까지 실행되도록 after()로 등록한다(위 3958번 줄 backgroundCompletion과 동일 이유).
  const backgroundCompletion = async () => {
    try {
      const restEnriched = await enrichQuietAccumBatch(restCandidates, trailingDates, trailingBySymbol);
      const fullRanked = scoreQuietAccumCandidates([...priorityEnriched, ...restEnriched], Math.min(20, topLimit));
      if (fullRanked.length > 0) {
        const fullRes: InvestorRankingResponse = {
          type: 'overlap', direction, period: periodLabel, list: fullRanked, isPartial: false, isMock: false, updatedAt: new Date().toISOString(),
        };
        quietAccumCacheStore.set(cacheKey, { data: fullRes, timestamp: Date.now() });
        upsertSharedRankCache(`full:${cacheKey}`, fullRanked).catch(() => {});
        syncSharedRankCache(cacheKey, fullRanked);
      }
    } catch (e: any) {
      console.warn('[Quiet Accum Background Completion Failed]', e?.message || e);
    } finally {
      quietAccumBackgroundInFlight.delete(cacheKey);
    }
  };

  if (restCandidates.length > 0) {
    if (quietAccumBackgroundInFlight.get(cacheKey)) {
      console.log(`[Quiet Accum Background Skip] cacheKey=${cacheKey} - 이미 진행 중인 완전판 계산이 있어 중복 실행을 건너뜁니다.`);
    } else {
      quietAccumBackgroundInFlight.set(cacheKey, true);
      try {
        const { after } = await import('next/server');
        after(backgroundCompletion);
      } catch (_) {
        backgroundCompletion();
      }
    }
  }

  return partialRes;
}

const comprehensiveCacheStore = getGlobalMap<string, { data: InvestorRankingResponse; timestamp: number }>('comprehensiveCacheStore');

export async function fetchKisComprehensiveScoreRanking(
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;

  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  const cacheKey = `comprehensive-${market}`;
  const cached = comprehensiveCacheStore.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60 * 1000) {
    return cached.data;
  }

  try {
    const [flucRes, volRes, amtRes, foreignRes, organRes] = await Promise.all([
      fetchKisSurgingStocks('fluctuation', market),
      fetchKisSurgingStocks('volume', market),
      fetchKisSurgingStocks('amount', market),
      fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', market),
      fetchKisForeignInstitutionRanking('organ', 'buy', '1d', market),
    ]);

    const candidateMap = new Map<string, RankingItem>();

    [...flucRes.list, ...volRes.list, ...amtRes.list].forEach((item) => {
      if (!candidateMap.has(item.symbol) && !isEtfSymbol(item.symbol, item.name)) {
        candidateMap.set(item.symbol, { ...item });
      }
    });

    const candidates = Array.from(candidateMap.values());
    const N = candidates.length;
    if (N === 0) {
      throw new Error('[KIS API 종합랭킹 응답 오류] 후보 종목 데이터가 없습니다.');
    }

    const flucSorted = [...candidates].sort((a, b) => b.changeRate - a.changeRate);
    const flucRankMap = new Map<string, number>(flucSorted.map((item, idx) => [item.symbol, idx + 1]));

    const amtSorted = [...candidates].sort((a, b) => (b.amountEok || 0) - (a.amountEok || 0));
    const amtRankMap = new Map<string, number>(amtSorted.map((item, idx) => [item.symbol, idx + 1]));

    const volIncSorted = [...candidates].sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const volIncRankMap = new Map<string, number>(volIncSorted.map((item, idx) => [item.symbol, idx + 1]));

    // 1. Trend Alignment Rank (정배열 추세 이격도)
    const trendAlignSorted = [...candidates].sort((a, b) => {
      const getTrendScore = (st: RankingItem) => {
        if (st.changeRate <= 0) return 20;
        const isStrong = (st.volumeIncreaseRate || 0) > 100 && st.changeRate > 5;
        return isStrong ? Math.min(75 + st.changeRate * 1.5, 100) : Math.min(45 + st.changeRate * 1.2, 70);
      };
      return getTrendScore(b) - getTrendScore(a);
    });
    const trendAlignRankMap = new Map<string, number>(trendAlignSorted.map((item, idx) => [item.symbol, idx + 1]));

    // 2. Close Strength Ratio (당일 캔들 마감 강도)
    const closeStrengthSorted = [...candidates].sort((a, b) => {
      const getStrength = (st: RankingItem) => {
        if (st.changeRate >= 29.5) return 100;
        const high = st.highPrice || Math.max(st.currentPrice, (st.openPrice || st.currentPrice));
        const low = st.lowPrice || Math.min(st.currentPrice, (st.openPrice || st.currentPrice));
        const close = st.currentPrice;
        if (high > low) return ((close - low) / (high - low)) * 100;
        return st.changeRate > 0 ? Math.min(60 + st.changeRate * 1.2, 95) : 30;
      };
      return getStrength(b) - getStrength(a);
    });
    const closeStrengthRankMap = new Map<string, number>(closeStrengthSorted.map((item, idx) => [item.symbol, idx + 1]));

    const foreignItemMap = new Map(foreignRes.list.map((item) => [item.symbol, item]));
    const organItemMap = new Map(organRes.list.map((item) => [item.symbol, item]));

    const N_foreign = foreignRes.list.length || 20;
    const N_organ = organRes.list.length || 20;

    const scoredItems: RankingItem[] = candidates.map((item) => {
      const flucRank = flucRankMap.get(item.symbol) || N;
      const amtRank = amtRankMap.get(item.symbol) || N;
      const volIncRank = volIncRankMap.get(item.symbol) || N;
      const trendAlignRank = trendAlignRankMap.get(item.symbol) || N;
      const closeStrengthRank = closeStrengthRankMap.get(item.symbol) || N;

      const flucScore = N > 1 ? Number((((N - flucRank) / (N - 1)) * 100).toFixed(1)) : 100;
      const amtScore = N > 1 ? Number((((N - amtRank) / (N - 1)) * 100).toFixed(1)) : 100;
      const volIncScore = N > 1 ? Number((((N - volIncRank) / (N - 1)) * 100).toFixed(1)) : 100;

      // Absolute Trend Alignment Score (절대 정배열 이격 점수)
      let trendAlignScore = 30;
      if (item.changeRate > 0) {
        const isStrong = (item.volumeIncreaseRate || 0) > 100 && item.changeRate > 5;
        trendAlignScore = Number((isStrong ? Math.min(75 + item.changeRate * 1.5, 100) : Math.min(45 + item.changeRate * 1.2, 70)).toFixed(1));
      }

      // Real Candle Close Strength Score (절대 당일 캔들 마감 강도 점수)
      let closeStrengthScore = 50;
      if (item.changeRate >= 29.5) {
        closeStrengthScore = 100;
      } else {
        const high = item.highPrice || Math.max(item.currentPrice, item.openPrice || item.currentPrice);
        const low = item.lowPrice || Math.min(item.currentPrice, item.openPrice || item.currentPrice);
        const close = item.currentPrice;
        if (high > low) {
          closeStrengthScore = Number((Math.min(Math.max((close - low) / (high - low), 0), 1) * 100).toFixed(1));
        } else if (item.changeRate > 0) {
          closeStrengthScore = Number((Math.min(60 + item.changeRate * 1.2, 95)).toFixed(1));
        } else {
          closeStrengthScore = 30;
        }
      }

      const fItem = foreignItemMap.get(item.symbol);
      let foreignScore = 20; // 랭킹 외 종목 20점 부여 (기존 50점 왜곡 방지)
      let foreignRank: number | null = null;
      let foreignSupplyBadge = '랭킹 외';
      let foreignSupplyDirection: 'buy' | 'sell' | 'none' = 'none';

      if (fItem) {
        foreignRank = fItem.rank;
        // 🚨 [버그 수정 - 수칙 1-6] `>= 0`이 순매수 정확히 0을 매수로 오판하던 버그 - 위
        // fetchKisSurgingOverlap과 동일 로직이 중복 구현돼 있었다.
        foreignSupplyDirection = fItem.netBuyAmt > 0 ? 'buy' : fItem.netBuyAmt < 0 ? 'sell' : 'none';
        const sign = fItem.netBuyAmt > 0 ? '+' : '';
        foreignSupplyBadge = `외국인 ${fItem.rank}위 (${sign}${fItem.netBuyAmtEok}억)`;
        foreignScore = Number((100 - ((fItem.rank - 1) / Math.max(N_foreign, 1)) * 50).toFixed(1));
      }

      const oItem = organItemMap.get(item.symbol);
      let organScore = 20; // 랭킹 외 종목 20점 부여 (기존 50점 왜곡 방지)
      let organRank: number | null = null;
      let organSupplyBadge = '랭킹 외';
      let organSupplyDirection: 'buy' | 'sell' | 'none' = 'none';

      if (oItem) {
        organRank = oItem.rank;
        organSupplyDirection = oItem.netBuyAmt > 0 ? 'buy' : oItem.netBuyAmt < 0 ? 'sell' : 'none';
        const sign = oItem.netBuyAmt > 0 ? '+' : '';
        organSupplyBadge = `기관 ${oItem.rank}위 (${sign}${oItem.netBuyAmtEok}억)`;
        organScore = Number((100 - ((oItem.rank - 1) / Math.max(N_organ, 1)) * 50).toFixed(1));
      }

      // Group 1: Momentum Burst Group (Vol 35%, Amt 30%, Fluc 20% = 85%) Non-linear RMS (p=2)
      const momSqSum = 35 * Math.pow(volIncScore, 2) + 30 * Math.pow(amtScore, 2) + 20 * Math.pow(flucScore, 2);
      const momRmsScore = Math.sqrt(momSqSum / 85);

      // Group 2: Confirmation / Filter Group (Trend 8%, Candle 2%, Foreign 2.5%, Organ 2.5% = 15%) Linear
      const confLinearScore = (trendAlignScore * 8 + closeStrengthScore * 2 + foreignScore * 2.5 + organScore * 2.5) / 15;

      // Hybrid Non-linear Total Score (Mom 85% + Conf 15%)
      const totalScore = Number((momRmsScore * 0.85 + confLinearScore * 0.15).toFixed(1));

      const scoreBreakdown: ScoreBreakdown = {
        totalScore,
        flucScore,
        amtScore,
        volIncScore,
        volScore: volIncScore,
        foreignScore,
        organScore,
        trendAlignScore,
        closeStrengthScore,
        flucRank,
        amtRank,
        volIncRank,
        volRank: volIncRank,
        foreignRank,
        organRank,
        trendAlignRank,
        closeStrengthRank,
      };

      return {
        ...item,
        rank: 0,
        scoreBreakdown,
        foreignSupplyBadge,
        organSupplyBadge,
        foreignSupplyDirection,
        organSupplyDirection,
        surgingMode: 'comprehensive',
        type: 'comprehensive',
      };
    });

    scoredItems.sort((a, b) => (b.scoreBreakdown?.totalScore || 0) - (a.scoreBreakdown?.totalScore || 0));

    scoredItems.forEach((item, idx) => {
      item.rank = idx + 1;
      registerRuntimeStockName(item.symbol, item.name);
    });

    const mergedList = await mergeCreditStatusToRanking(scoredItems);

    const result: InvestorRankingResponse = {
      type: 'comprehensive' as RankingType,
      direction: 'buy',
      period: '1d',
      list: mergedList,
      isMock: false,
      updatedAt: new Date().toISOString(),
    };

    comprehensiveCacheStore.set(cacheKey, { data: result, timestamp: Date.now() });
    syncSharedRankCache(cacheKey, result.list);

    return result;
  } catch (err) {
    console.error('[KIS Comprehensive Ranking Exception]', err);
    throw err;
  }
}

// ============================================================================
// 📊 [신규 독립 모듈] 당일 3분봉 캔들 + 피봇 포인트 + 피보나치 지표 연산 엔진
// ============================================================================
const intraday3mMemoryCache = new Map<string, { data: IntradayChartResponse; timestamp: number }>();

/**
 * 특정 날짜에 로컬 디스크에 실시간 부분저장(save3mCandlesToDiskAsync)이 한 번이라도 찍힌 심볼과
 * 그 시점 봉 개수를 스캔해서 반환한다. TOP_300_STOCKS 큐레이션 목록 밖(검색으로 연 임의 종목 등)이라도
 * 그날 실제로 조회된 적이 있으면 파일명(3m_{date}_{symbol}.json)에 흔적이 남으므로, EOD 아카이빙
 * 크론이 "완전체(130개)로 다시 채워야 할 추가 대상"을 찾는 데 Supabase 조회와 함께 병행 사용한다.
 */
export function listLocalTodayViewed3mSymbols(date: string): Array<{ symbol: string; count: number }> {
  if (!date) return [];
  try {
    const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
    if (!fs.existsSync(dir)) return [];
    const prefix = `3m_${date}_`;
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => {
        const symbol = f.slice(prefix.length, -'.json'.length);
        let count = 0;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          count = Array.isArray(parsed) ? parsed.length : 0;
        } catch (_) {}
        return { symbol, count };
      });
  } catch (e) {
    console.warn('[listLocalTodayViewed3mSymbols Failed]', e);
    return [];
  }
}

export async function fetchKis3mCandlesFullDay(
  symbol: string,
  timeUnit: '3m' = '3m'
): Promise<IntradayChartResponse> {
  const matchedUniverseStock = TOP_300_STOCKS.find((s) => s.symbol === symbol);
  const stockName = matchedUniverseStock?.name || getStockName(symbol);
  const cacheKey = `3m-candles-${symbol}-${timeUnit}`;
  const dynamicTtl = getDynamicRankingTtl();

  // 1. In-Memory Cache Check (0ms latency)
  if (intraday3mMemoryCache.has(cacheKey)) {
    const cached = intraday3mMemoryCache.get(cacheKey)!;
    if (Date.now() - cached.timestamp < dynamicTtl) {
      return cached.data;
    }
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  const token = await getKisAccessToken();
  if (!token) {
    throw new Error('[KIS 인증 토큰 발급 실패]');
  }

  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  try {
    // 현재 KST 시각 계산 (장중 미래 시간대 더미 틱 방지)
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const kstDate = new Date(utc + 9 * 60 * 60000);
    const kstHour = kstDate.getHours();
    const kstMinute = kstDate.getMinutes();
    const kstTimeNum = kstHour * 100 + kstMinute;
    // 🚨 [애프터마켓 도입 후에도 15:30 그대로 유지 - 실측 확인] 아래 allSlots가 09:00~15:30 정규장
    // 30분 슬롯 14개로 고정돼 있는데, 이건 캐시 정책이 아니라 KIS 3분봉 TR(FHKST03010200) 자체의
    // 한계다 - 실측(watch-debug로 raw 응답 직접 확인)해보니 애프터마켓 도입 후에도 이 TR은 16:00 이후
    // 봉을 전혀 안 준다(마지막 봉이 항상 15:30). getDynamicRankingTtl() 등 다른 곳과 달리 여기는 20:00로
    // 늘려봤자 KIS가 데이터를 안 주므로 그대로 둔다.
    const isTodayMarketOpen = kstDate.getDay() >= 1 && kstDate.getDay() <= 5 && kstTimeNum >= 900 && kstTimeNum < 1530;
    const todayYmd = `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;

    // 🎯 [KIS 실시간 웹소켓 브릿지 연동] 오라클 서버에서 상시 구동 중인 ws-bridge(H0UNCNT0 통합체결가
    // 구독)가 15초 주기로 Supabase(intraday_3m_candles)에 오늘자 3분봉을 직접 쌓고 있다 - REST(J,
    // KRX전용, 애프터마켓 미지원)보다 더 정확(NXT 포함)하고 더 넓은 시간대(20:00까지)를 커버한다.
    // updated_at이 신선하면(=브릿지가 이 종목을 감시 중이고 서버가 살아있음) 아래 REST 슬롯 조회를
    // 통째로 건너뛰고 이 데이터를 그대로 쓴다. 신선하지 않으면 null이 반환되어 기존 REST 경로로 100%
    // 그대로 폴백한다 - 이 종목이 브릿지 감시 대상인지 앱이 미리 알 필요가 없다(신선도 체크 하나로 자동 판별).
    //
    // 🚨 [버그 수정 - 사용자 지적: "6시까지 애프터마켓 했을텐데 3분봉 왜 3시 30분까지야?"] 장중(45초
    // 이내)에만 신선하다고 보는 고정값을 그대로 장마감 후에도 썼더니, 장 마감(애프터마켓 포함 20:00) 이후
    // 브릿지가 더 이상 새로 쓸 데이터가 없어져 45초가 금방 지나버리고 REST(15:30 고정) 폴백으로 떨어져
    // 있었다 - 정작 브릿지가 그날 20:00까지 정상적으로 다 모아둔 데이터를 버리고 있었다. 장(정규+애프터
    // 마켓)이 완전히 끝난 시간대(20:00~09:00)에는 "그날 하루치는 이제 더 안 바뀐다"는 뜻이므로, 오래된
    // updated_at이라도 오늘 날짜(todayYmd)로 저장된 것이면 그대로 신뢰한다(24시간 - 다음날 새벽까지도
    // 어제자 조회 시 유효).
    const isMarketFullyClosedForToday = kstTimeNum >= 2000 || kstTimeNum < 900;
    const bridgeFreshnessMs = isMarketFullyClosedForToday ? 24 * 60 * 60 * 1000 : 45000;
    // 🚨 [버그 수정 - 사용자 지적: "동양뿐만 아니라 다 걸리는 거 아니야?"] intraday_3m_candles는 REST
    // 폴백(이 함수 자신)의 일회성 스냅샷도 같은 테이블/같은 updated_at에 저장한다. ws_watchlist(브릿지가
    // 실제로 감시 중인 종목의 정본 목록)에 없는 종목은, 하루 중 아무 때나 한 번이라도 조회되면 그 시점의
    // 부분 스냅샷이 "최근에 업데이트됨"이라는 이유만으로 영구히 신선한 데이터로 오인되어(그리고 그걸 다시
    // 저장하면서 updated_at만 계속 지금 시각으로 갱신) 그 시점에 차트가 영원히 고정되는 버그가 있었다
    // (실측: 동양 001520이 09:12에 멈춘 채 몇 시간째 그대로였음). ws-bridge 감시 대상이 아니면 애초에
    // "신선한 브릿지 데이터"로 오인할 여지 자체를 차단하고 무조건 REST로 그 시점 실제 데이터를 다시 받는다.
    const isBridgeWatched = await isSymbolInWsWatchlist(symbol);
    const bridgeCandles = isBridgeWatched
      ? await fetchFreshIntraday3mCandlesFromSupabase(todayYmd, symbol, bridgeFreshnessMs)
      : null;

    let aggregatedAll: Array<{
      date: string;
      time: string;
      rawTime: string;
      openPrice: number;
      highPrice: number;
      lowPrice: number;
      closePrice: number;
      volume: number;
    }> = [];

    if (bridgeCandles) {
      aggregatedAll = bridgeCandles;
    } else {
      // 09:00 장시작 전일 데이터 및 09:00~15:30 시간대 슬롯 병렬 초고속 수집
      const allSlots = [
        '090000', '093000', '100000', '103000', '110000', '113000', '120000',
        '123000', '130000', '133000', '140000', '143000', '150000', '153000'
      ];

      // 장중에는 현재 시각 이후의 먼 미래 슬롯을 호출하지 않아 KIS API의 고착 더미 데이터 원천 차단
      // (HHMM 문자열을 그대로 정수로 취급해 덧셈하면 분이 60을 넘어갈 때 시(hour) 경계를 넘지 못하는 연산 버그가 있어,
      //  분(minute) 단위 선형값으로 환산하여 비교 - 예: 09:58 + 30분 = 10:28이 되어야 정상)
      const nowTotalMinutes = kstHour * 60 + kstMinute;
      const timeSlots = allSlots.filter((slotStr) => {
        if (!isTodayMarketOpen) return true;
        const sHour = parseInt(slotStr.slice(0, 2), 10);
        const sMin = parseInt(slotStr.slice(2, 4), 10);
        const slotTotalMinutes = sHour * 60 + sMin;
        return slotTotalMinutes < nowTotalMinutes + 30; // 현재 진행 중인 30분 슬롯까지만 요청 (분 단위 선형 비교)
      });

      // 🚨 [버그 수정 - 두 번째 라운드, 진단으로 확정한 진짜 근본 원인] 처음엔 이 14개 슬롯을 kisQueue로
      // 완전 직렬화(200ms 간격, 1개씩)했었는데, 실측(scratch/diagnose_3m_concurrency*.js + Vercel 프로덕션
      // 진단 라우트)으로 KIS 자체는 14개~70개 동시 요청에도 수백ms~2초 내로 문제없이 응답하고, 레이트리밋도
      // "즉시 거부"일 뿐 hang이 아님을 확인했다. 진짜 원인은 kisQueue.enqueue()의 구조적 결함이었다 -
      // task.fn()이 타임아웃 없이 hang되면 processNext()의 finally(isProcessing=false)가 영원히 안
      // 실행되어, 그 fetch를 처리하던 서버리스 인스턴스의 kisQueue 전체가 영구히 멈추고, Vercel이 그
      // "죽은" 인스턴스를 재사용(warm reuse)하면 이후 모든 요청이 계속 hang됐다. kisQueue의 직렬화 자체가
      // 필요한 게 아니라, 개별 fetch의 타임아웃 부재가 문제였으므로 - 이제 각 fetch에 8초 타임아웃과
      // 레이트리밋 자동 재시도(fetchWithRetry)가 있으니 kisQueue 없이 원래처럼 병렬로 처리해도 안전하고,
      // 훨씬 빠르다(직렬화 시 종목당 13~22초 → 병렬 시 실측 수백ms~2초).
      const responses = await Promise.all(
        timeSlots.map(async (slotHour) => {
          try {
            return await fetchWithRetry(async () => {
              // 🚨 [원상복구 - 실수 인정] NXT 통합거래량 삼성전자로 실측했을 때(UN=J+NX 정확 일치)만 보고
              // UN으로 바꿨는데, NXT 비상장 종목(실측: 하나마이크론 067310)에서 UN을 쓰면 output1(요약)은
              // 정상인데 output2(분봉 배열)만 전 구간이 "전일종가 고정 + 거래량 0"인 깨진 값으로 온다는 걸
              // 놓쳤다. NXT는 전체 종목의 일부(~800개)만 지원해서 나머지 대다수 종목의 3분봉이 이 변경으로
              // 망가졌었다(실측: 하나마이크론이 하루종일 평평한 라인으로 보임). J(KRX전용)로 원상복구한다.
              // 일봉(inquire-daily-itemchartprice)·프로그램매매(program-trade-by-stock)는 같은 종목으로
              // 재검증했을 때 이런 증상이 없어 UN 유지가 안전함을 확인했다.
              const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_HOUR_1=${slotHour}&FID_PW_DATA_INCU_YN=Y&FID_ETC_CLS_CODE=`;
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 8000);
              try {
                const res = await fetch(url, {
                  method: 'GET',
                  headers: {
                    'content-type': 'application/json; charset=utf-8',
                    authorization: `Bearer ${token}`,
                    appkey: appKey,
                    appsecret: appSecret,
                    tr_id: 'FHKST03010200',
                    custtype: 'P',
                  },
                  cache: 'no-store',
                  signal: controller.signal,
                });
                if (!res.ok) throw new Error(`3분봉 슬롯(${slotHour}) 조회 HTTP ${res.status}`);
                const json = await res.json();
                return Array.isArray(json.output2) ? json.output2 : [];
              } finally {
                clearTimeout(timeoutId);
              }
            });
          } catch (e: any) {
            console.warn(`[3분봉 슬롯 조회 실패] ${symbol} ${slotHour}: ${e?.message || e}`);
            return [];
          }
        })
      );

      // 🚨 [버그 수정] 당일 신규상장 종목(실측: 스카이랩스 386380)에서 KIS가 일부 틱을 현재가 "0"과
      // cntg_vol "-9223372036854775808"(Int64 최솟값 - 정상 체결량이 될 수 없는 값, KIS 측 데이터 없음/
      // 오류 센티널로 추정)로 반환하는 게 실측(DEBUG_3M_CANDLES 진단 로그)으로 확인됐다. 이런 깨진 틱을
      // 그대로 3분봉에 섞어 집계하면 시가/고가/저가/종가가 전부 0, 거래량이 천문학적 음수인 가짜 봉이
      // "생성"되어(정상 생성이 아니라 깨진 데이터가 뜨는 것) 신규상장일 당일 3분봉이 사실상 안 나오는
      // 것처럼 보였다. 정상 체결이라면 현재가는 반드시 양수, 거래량은 반드시 0 이상이어야 하므로, 이
      // 조건을 만족하지 못하는 틱은 진짜 체결이 아니라고 보고 집계 자체에서 제외한다(가짜 보간이 아니라
      // "이 틱은 없었던 것으로 취급" - 그 3분 슬롯에 살아있는 틱이 하나도 없으면 그 슬롯은 그냥 빈다).
      const isValidTick = (row: any): boolean => {
        const price = parseInt(row?.stck_prpr || '0', 10);
        const vol = parseInt(row?.cntg_vol || '0', 10);
        return Number.isFinite(price) && price > 0 && Number.isFinite(vol) && vol >= 0;
      };
      const allRawCandles = responses.flat().filter(isValidTick);

      // 날짜 + 시간 기준 중복 제거 및 오름차순 정렬
      const uniqueMap = new Map<string, any>();
      allRawCandles.forEach((row) => {
        const k = `${row.stck_bsop_date || ''}_${row.stck_cntg_hour || ''}`;
        if (!uniqueMap.has(k)) uniqueMap.set(k, row);
      });

      const sortedRaw = Array.from(uniqueMap.values()).sort((a, b) => {
        const dDiff = parseInt(a.stck_bsop_date || '0', 10) - parseInt(b.stck_bsop_date || '0', 10);
        if (dDiff !== 0) return dDiff;
        return parseInt(a.stck_cntg_hour || '0', 10) - parseInt(b.stck_cntg_hour || '0', 10);
      });

      // 1분 틱 데이터를 날짜별/3분 단위(3-Minute OHLCV)로 묶기
      const slotMap = new Map<string, { date: string; time: string; ticks: any[] }>();
      sortedRaw.forEach((row) => {
        const dateStr = row.stck_bsop_date || '99999999';
        const hStr = row.stck_cntg_hour || '090000';
        const hour = parseInt(hStr.slice(0, 2), 10);
        const min = parseInt(hStr.slice(2, 4), 10);
        const slotMin = Math.floor(min / 3) * 3;
        const timeKey = `${String(hour).padStart(2, '0')}:${String(slotMin).padStart(2, '0')}`;
        const compositeKey = `${dateStr}_${timeKey}`;

        if (!slotMap.has(compositeKey)) {
          slotMap.set(compositeKey, { date: dateStr, time: timeKey, ticks: [] });
        }
        slotMap.get(compositeKey)!.ticks.push(row);
      });

      slotMap.forEach(({ date, time, ticks }) => {
        if (ticks.length === 0) return;
        const firstTick = ticks[0];
        const lastTick = ticks[ticks.length - 1];

        const openPrice = parseInt(firstTick.stck_oprc || firstTick.stck_prpr || '0', 10);
        const closePrice = parseInt(lastTick.stck_prpr || lastTick.stck_oprc || '0', 10);

        let highPrice = -Infinity;
        let lowPrice = Infinity;
        let totalVolume = 0;

        ticks.forEach((t) => {
          const h = parseInt(t.stck_hgpr || t.stck_prpr || '0', 10);
          const l = parseInt(t.stck_lwpr || t.stck_prpr || '0', 10);
          const p = parseInt(t.stck_prpr || '0', 10);
          const v = parseInt(t.cntg_vol || '0', 10);

          if (h > 0 && h > highPrice) highPrice = h;
          if (p > 0 && p > highPrice) highPrice = p;

          if (l > 0 && l < lowPrice) lowPrice = l;
          if (p > 0 && p < lowPrice) lowPrice = p;

          totalVolume += v;
        });

        if (highPrice === -Infinity) highPrice = Math.max(openPrice, closePrice);
        if (lowPrice === Infinity) lowPrice = Math.min(openPrice, closePrice);

        aggregatedAll.push({
          date,
          time,
          rawTime: lastTick.stck_cntg_hour || '090000',
          openPrice,
          highPrice,
          lowPrice,
          closePrice,
          volume: totalVolume,
        });
      });
    }

    const allDates = Array.from(new Set(aggregatedAll.map((c) => c.date))).sort();
    const latestDate = allDates[allDates.length - 1] || todayYmd;

    // ========================================================================
    // 1. 직전 거래일(어제) 확정 일봉(High, Low, Close, Open) 조회 (피봇 및 130개 롤링용)
    // ========================================================================
    let refHigh = 0;
    let refLow = Infinity;
    let refClose = 0;
    let refOpen = 0;
    let prevTradeDateStr = 'PREV';
    // 🎯 [기능 추가 - 사용자 요청: "hts, mts처럼", "3분봉 130개 이상 된다며"] 예전엔 직전 1거래일만 오늘과
    // 이어붙여 130개로 캡핑했는데, 이러면 줌아웃해도 "오늘 하루치"만 보여서 진짜 HTS/MTS처럼 지난 며칠치를
    // 스크롤/줌아웃으로 보는 게 불가능했다. 아래에서 확정된 과거 거래일 목록을 미리 확보해뒀다가, 4번
    // 섹션에서 최근 여러 거래일의 아카이브를 한꺼번에 이어붙인다(가짜 보간 없이 실제 아카이브가 있는 날짜만).
    let recentPastTradeDates: string[] = [];

    try {
      // executeKisInvestorTrendFetch(raw)를 직접 호출하면 kisQueue 레이트리밋 보호와 재시도가 전혀 없어
      // 순간 실패 시 곧장 아래 폴백(당일 장중 데이터 기준 재계산)으로 떨어져 "전일 고정" 원칙이 깨진다.
      // fetchKisInvestorTrend(공개 래퍼)를 사용해 캐시 + kisQueue + 3회 재시도 보호를 동일하게 적용한다.
      const dailyTrend = await fetchKisInvestorTrend(symbol, '20d');
      if (dailyTrend && dailyTrend.trend && dailyTrend.trend.length > 0) {
        // 당일(오늘 장중 일봉)을 명시적으로 제외한 확정 과거 거래일 목록 필터링
        const pastDailies = dailyTrend.trend
          .map((item: any) => {
            const rawD = String(item.stck_bsop_date || item.date || item.formattedDate || '').replace(/[^0-9]/g, '');
            return { ...item, _numericDate: rawD ? parseInt(rawD, 10) : 0, _strDate: rawD };
          })
          .filter((item: any) => {
            const dStr = item._strDate;
            const isToday = (dStr && dStr === todayYmd) || (latestDate && dStr === latestDate);
            return !isToday && item._numericDate > 0 && item.highPrice && item.lowPrice && item.closePrice;
          })
          .sort((a: any, b: any) => a._numericDate - b._numericDate);

        recentPastTradeDates = pastDailies.map((item: any) => item._strDate).filter(Boolean);

        if (pastDailies.length > 0) {
          const targetDaily = pastDailies[pastDailies.length - 1];
          refHigh = Number(targetDaily.highPrice || 0);
          refLow = Number(targetDaily.lowPrice || 0);
          refClose = Number(targetDaily.closePrice || 0);
          refOpen = Number(targetDaily.openPrice || refClose);
          prevTradeDateStr = targetDaily._strDate || 'PREV';
        }
      }
    } catch (e: any) {
      // 무음 실패 금지: 전일 확정 일봉 조회가 실패하면 피봇/피보나치가 "전일 고정" 원칙을 벗어나
      // 당일 장중 데이터 기준(아래 폴백)으로 대체되므로, 원인 추적이 가능하도록 반드시 로그를 남긴다.
      console.warn(`[3분봉 피봇 전일 일봉 조회 실패] ${symbol}: ${e?.message || e} → 당일 장중 데이터 기준 폴백으로 대체 (전일 고정 원칙 이탈)`);
    }

    if (refHigh === 0 || refLow === Infinity || refClose === 0) {
      const closes = aggregatedAll.map((c: any) => c.closePrice || 0).filter((p: number) => p > 0);
      const highs = aggregatedAll.map((c: any) => c.highPrice || 0).filter((p: number) => p > 0);
      const lows = aggregatedAll.map((c: any) => c.lowPrice || 0).filter((p: number) => p > 0);
      refClose = closes.length > 0 ? closes[closes.length - 1] : (aggregatedAll[0]?.closePrice || 0);
      refHigh = highs.length > 0 ? Math.max(...highs) : refClose;
      refLow = lows.length > 0 ? Math.min(...lows) : refClose;
      refOpen = aggregatedAll[0]?.openPrice || refClose;
    }
    if (refLow === Infinity) refLow = refClose;

    // ========================================================================
    // 2. 디스크 영구 아카이브 헬퍼 함수 (비동기 논블로킹 & 중복 I/O 방지)
    // ========================================================================
    const get3mArchiveDir = (): string => {
      const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { }
      }
      return dir;
    };

    const save3mCandlesToDiskAsync = (sym: string, dt: string, cList: any[]): void => {
      if (!sym || !dt || !cList || cList.length === 0) return;
      // 이벤트 루프를 전혀 블로킹하지 않도록 setImmediate로 백그라운드 큐에 위임
      setImmediate(async () => {
        // 1. 로컬 디스크 저장 (로컬 개발 중 즉시 눈으로 확인 가능한 보조 저장소)
        try {
          const dir = get3mArchiveDir();
          const filePath = path.join(dir, `3m_${dt}_${sym}.json`);
          await fs.promises.writeFile(filePath, JSON.stringify(cList, null, 2), 'utf8');
        } catch (err) {
          console.warn(`[save3mCandlesToDiskAsync Failed] ${sym} (${dt}):`, err);
        }
        // 2. Supabase 저장 (Vercel 서버리스 인스턴스 재생성/콜드스타트에도 유실되지 않는 영구 저장소)
        try {
          const saved = await saveIntraday3mCandlesToSupabase(dt, sym, cList);
          if (!saved) {
            console.warn(`[3m Candles Supabase Save Skipped] ${sym} (${dt})`);
          }
        } catch (err) {
          console.warn(`[3m Candles Supabase Save Exception] ${sym} (${dt}):`, err);
        }
      });
    };

    const load3mCandlesFromDisk = async (sym: string, dt: string): Promise<any[] | null> => {
      if (!sym || !dt) return null;

      // 1. Supabase 우선 조회 (서버리스 인스턴스 간에도 항상 동일하게 보이는 정본 저장소)
      try {
        const fromSupabase = await fetchIntraday3mCandlesFromSupabase(dt, sym);
        if (fromSupabase && fromSupabase.length > 0) return fromSupabase;
      } catch (err) {
        console.warn(`[3m Candles Supabase Read Exception] ${sym} (${dt}):`, err);
      }

      // 2. 로컬 디스크 폴백 (Supabase 미설정/장애 시에도 로컬 개발이 끊기지 않도록)
      try {
        const dir = get3mArchiveDir();
        const filePath = path.join(dir, `3m_${dt}_${sym}.json`);
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch (err) {
        console.warn(`[load3mCandlesFromDisk Failed] ${sym} (${dt}):`, err);
      }
      return null;
    };

    // ========================================================================
    // 3. 당일(오늘) KIS 실시간 3분봉 추출 및 디스크 영구 저장 (유실 방지)
    // ========================================================================
    const todayCandles = aggregatedAll
      .filter((c) => {
        if (c.date !== latestDate) return false;
        if (isTodayMarketOpen) {
          const [ch, cm] = c.time.split(':').map(Number);
          const cTimeNum = ch * 100 + cm;
          if (cTimeNum > kstTimeNum) return false;
        }
        return true;
      })
      .map((c) => ({
        ...c,
        formattedDate: c.date.length === 8 ? `${c.date.slice(4, 6)}/${c.date.slice(6, 8)}` : '오늘',
      }));

    // 당일 수집된 실시간 3분봉을 비동기 논블로킹 방식으로 디스크에 영구 저장 (이벤트 루프 지연 0ms)
    if (todayCandles.length > 0) {
      save3mCandlesToDiskAsync(symbol, latestDate, todayCandles);
    }

    // ========================================================================
    // 4. 최근 여러 거래일 실제 3분봉 데이터 확보 (HTS/MTS처럼 줌아웃하면 지난 날짜까지 이어서 보이게 -
    //    가짜 보간 전면 폐기, 아카이브가 실제로 있는 날짜만 이어붙인다)
    // ========================================================================
    const PAST_TRADING_DAYS_TO_STITCH = 5; // 오늘 제외 최근 5거래일 - Supabase 병렬 조회라 지연 미미
    const datesToLoad = recentPastTradeDates.slice(-PAST_TRADING_DAYS_TO_STITCH);
    const archivedDaysRaw = await Promise.all(datesToLoad.map((dt) => load3mCandlesFromDisk(symbol, dt)));
    // 🚨 [버그 수정 - 사용자 지적: "삼성전자 3분봉 또 왜저러는데"] 실측 확인(2026-09-23): Supabase
    // intraday_3m_candles에 date="20260922" 키인데 내부 캔들은 실제로 09/18·09/21 데이터가 섞여
    // 저장된 오염 행이 있었다(005930/000660/034020 3종목, 전부 2026-09-22 20:00:12 KST 애프터마켓
    // 마감 경계에 저장됨 - 쓰기 단계의 근본 원인은 이번 진단 범위 밖). 저장 단계 버그가 또 재발해도
    // 화면까지 새어나가지 않도록, 읽은 배치의 내부 date가 요청한 날짜와 실제로 일치하는 것만 신뢰한다
    // (수칙 1-3 - 정합성 안 맞는 데이터는 그냥 버림, 가짜로 보정하지 않음).
    const archivedDays = archivedDaysRaw.map((day, i) => {
      if (!Array.isArray(day) || day.length === 0) return day;
      const expectedDate = datesToLoad[i];
      const mismatched = day.filter((c: any) => c.date !== expectedDate);
      if (mismatched.length > 0) {
        console.warn(`[3분봉 아카이브 정합성 오류] ${symbol} ${expectedDate} 요청했는데 내부에 다른 날짜 ${mismatched.length}/${day.length}건 섞여있어 이 배치 전체를 버림 (내부 날짜: ${[...new Set(day.map((c: any) => c.date))].join(',')})`);
        return null;
      }
      return day;
    });
    let prevDayRealCandles: any[] = archivedDays
      .filter((day): day is any[] => Array.isArray(day) && day.length > 0)
      .flat();
    const stitchedPastDayCount = archivedDays.filter((day) => Array.isArray(day) && day.length > 0).length;

    if (prevDayRealCandles.length === 0) {
      // 아카이브가 전혀 없는 경우(신규상장 등) KIS 실시간 API에서 수신된 어제 실제 틱 분봉만 사용 (가짜 보간 일체 금지)
      prevDayRealCandles = aggregatedAll
        .filter((c) => c.date !== latestDate)
        .map((c) => ({
          ...c,
          formattedDate: c.date.length === 8 ? `${c.date.slice(4, 6)}/${c.date.slice(6, 8)}` : '어제',
        }));
    }

    // ========================================================================
    // 5. 100% 실제 데이터 결합 (최근 여러 거래일 실제 봉 + 오늘 실제 실시간 봉 - 인위적 130개 상한 제거)
    // ========================================================================
    const combinedReal = [...prevDayRealCandles, ...todayCandles];

    // ========================================================================
    // 6. 실제 봉 배열 대상 연속 이동평균선(MA5, MA20, MA60) 정석 연산
    // ========================================================================
    // VWAP(거래량가중평균가) - 당일 장 시작부터의 누적(전형가×거래량)/누적거래량. combinedReal은 어제
    // 실제 봉 + 오늘 실시간 봉이 이어붙어 있으므로, 날짜가 바뀌는 지점에서 누적치를 반드시 리셋해야
    // "어제 매물까지 섞인 가짜 VWAP"이 되지 않는다(하루 단위로 끊어서 계산하는 게 VWAP의 정의 그 자체).
    //
    // VWAP 표준편차 밴드(±1σ/±2σ) - 거래량가중 분산(Var = E[X²] - E[X]²)을 VWAP과 동일하게 누적으로
    // 계산한다. cumPV2(전형가²×거래량의 누적)를 추가로 누적해서 매 시점마다 그 시점까지의 표준편차를
    // 구한다 - 장 시작 직후엔 누적 표본이 적어 밴드가 좁고 불안정한 게 VWAP 밴드의 원래 특성이라
    // 별도 보정 없이 그대로 둔다(가짜 안정화 금지).
    let vwapCumPV = 0;
    let vwapCumPV2 = 0;
    let vwapCumVol = 0;
    let vwapDate = '';
    const vwapByIndex: Array<{ vwap: number; upper1: number; lower1: number; upper2: number; lower2: number }> = combinedReal.map((c) => {
      if (c.date !== vwapDate) {
        vwapDate = c.date;
        vwapCumPV = 0;
        vwapCumPV2 = 0;
        vwapCumVol = 0;
      }
      const typicalPrice = (c.highPrice + c.lowPrice + c.closePrice) / 3;
      vwapCumPV += typicalPrice * c.volume;
      vwapCumPV2 += typicalPrice * typicalPrice * c.volume;
      vwapCumVol += c.volume;

      if (vwapCumVol <= 0) {
        return { vwap: c.closePrice, upper1: c.closePrice, lower1: c.closePrice, upper2: c.closePrice, lower2: c.closePrice };
      }
      const vwap = vwapCumPV / vwapCumVol;
      const variance = Math.max(0, vwapCumPV2 / vwapCumVol - vwap * vwap); // 부동소수점 오차로 아주 살짝 음수가 나올 수 있어 0 하한
      const stdDev = Math.sqrt(variance);
      return {
        vwap: Math.round(vwap),
        upper1: Math.round(vwap + stdDev),
        lower1: Math.round(vwap - stdDev),
        upper2: Math.round(vwap + 2 * stdDev),
        lower2: Math.round(vwap - 2 * stdDev),
      };
    });

    const candles: IntradayCandlePoint[] = combinedReal.map((c, idx, arr) => {
      // MA5
      const slice5 = arr.slice(Math.max(0, idx - 4), idx + 1);
      const ma5 = Math.round(slice5.reduce((acc, x) => acc + x.closePrice, 0) / slice5.length);

      // MA20
      const slice20 = arr.slice(Math.max(0, idx - 19), idx + 1);
      const ma20 = Math.round(slice20.reduce((acc, x) => acc + x.closePrice, 0) / slice20.length);

      // MA60
      const slice60 = arr.slice(Math.max(0, idx - 59), idx + 1);
      const ma60 = Math.round(slice60.reduce((acc, x) => acc + x.closePrice, 0) / slice60.length);

      return {
        date: c.date,
        formattedDate: (c as any).formattedDate || (c.date.length === 8 ? `${c.date.slice(4, 6)}/${c.date.slice(6, 8)}` : ''),
        time: c.time,
        rawTime: c.rawTime,
        openPrice: c.openPrice,
        highPrice: c.highPrice,
        lowPrice: c.lowPrice,
        closePrice: c.closePrice,
        volume: c.volume,
        ma5,
        ma20,
        ma60,
        vwap: vwapByIndex[idx].vwap,
        vwapUpper1: vwapByIndex[idx].upper1,
        vwapLower1: vwapByIndex[idx].lower1,
        vwapUpper2: vwapByIndex[idx].upper2,
        vwapLower2: vwapByIndex[idx].lower2,
      };
    });

    const totalCount = candles.length;
    const todayCount = todayCandles.length;
    const prevCount = totalCount - todayCount;
    const statusNotice = stitchedPastDayCount > 0
      ? `최근 ${stitchedPastDayCount}거래일 + 오늘 3분봉 이어붙임 (과거 ${prevCount}개 + 오늘 ${todayCount}개)`
      : `총 ${totalCount}개 봉 표시 중 (과거 아카이브 없음, 오늘 ${todayCount}개)`;

    // 1. 클래식 피봇 포인트 (Pivot Points - 전일 일봉 기준 불변 고정선)
    // 계산값을 실제 KRX 호가단위에 맞춰 반올림 (실제로 존재하지 않는 호가가 화면에 뜨는 것 방지)
    const P = roundToKrxTick((refHigh + refLow + refClose) / 3);
    const R1 = roundToKrxTick(2 * P - refLow);
    const R2 = roundToKrxTick(P + (refHigh - refLow));
    const S1 = roundToKrxTick(2 * P - refHigh);
    const S2 = roundToKrxTick(P - (refHigh - refLow));

    // 2. 피보나치 되돌림 라인 (전일 일봉 파동 기준 불변 고정선)
    const range = refHigh - refLow;
    const fibo236 = roundToKrxTick(refHigh - range * 0.236);
    const fibo382 = roundToKrxTick(refHigh - range * 0.382);
    const fibo500 = roundToKrxTick(refHigh - range * 0.500);
    const fibo618 = roundToKrxTick(refHigh - range * 0.618);

    const levels: IntradayPivotFibonacciLevels = {
      pivot: { r2: R2, r1: R1, p: P, s1: S1, s2: S2 },
      fibonacci: { fibo236, fibo382, fibo500, fibo618 },
      daySummary: { high: refHigh, low: refLow, close: refClose, range },
    };

    const response: IntradayChartResponse = {
      symbol,
      name: stockName,
      timeUnit,
      candles,
      levels,
      totalCount,
      todayCount,
      prevCount,
      statusNotice,
      isMock: false,
      updatedAt: new Date().toISOString(),
    };

    intraday3mMemoryCache.set(cacheKey, { data: response, timestamp: Date.now() });
    return response;
  } catch (err) {
    console.error(`[KIS Intraday 3m Candles Exception] ${symbol}:`, err);
    throw err;
  }
}

// ============================================================================
// 🎯 [재설계 - 사용자 요청: "5개만 하면 볼 이유 없다", "더 빠르게 안돼?"] 원래 온디맨드 3분봉 재구성
// (종목당 KIS 14콜) 방식은 누를 때마다 최대 76초까지 걸려서 "지금 당장 들어가야 하는" 실전 타이밍
// 도구로는 근본적으로 안 맞았다. KIS 당일 현재가 조회(FHKST01010100) 1콜에 이미 누적거래량(acml_vol)·
// 누적거래대금(acml_tr_pbmn)이 들어있고, VWAP는 정의상 "누적거래대금 ÷ 누적거래량"이므로 이 1콜만으로
// 정확한 VWAP를 즉시 계산할 수 있다 - 3분봉을 다시 쌓을 필요가 없다. 종목당 비용이 14콜→1콜로 줄어서,
// 5종목으로 좁힐 필요 없이 화면에 보이는 후보 전체(최대 60개)를 짧은 주기로 계속 감시할 수 있다.
// 트레이드오프(사용자와 합의): 이 방식은 "감시가 시작된 시점부터의 흐름"만 서버 메모리에 쌓아서 판단한다
// (오늘 아침에 있었던 재돌파 이력은 못 봄) - 지금 당장의 진입 타이밍이 목적이므로 오히려 더 맞는 방향.

interface VwapWatchSample {
  ts: number;
  price: number;
  cumVol: number;
  vwap: number;
}

// 🚨 [버그 수정 - 사용자 지적: "떴다가 바로 사라진다"] "재돌파했었는지"(hasBeenBelow)와 "몇 번
// 전환됐는지"(crossCount)는 표본 창 크기와 무관하게 감시가 시작된 이후 영구 보존한다 - 최근 표본 창
// (samples)만 잘라내면서 그 증거까지 같이 유실됐던 게 "5분만 지나면 재돌파가 사라지는" 버그의 원인이었다.
interface VwapWatchState {
  dateStr: string; // 🚨 [버그 수정 - 코드 리뷰 발견: 자정을 넘겨도 상태가 안 지워짐] 이 상태가 어느
  // 거래일 것인지 - 이게 없으면 프로세스가 자정을 넘겨 살아있는 동안(서버리스 웜 인스턴스) 어제자
  // hasBeenBelow/crossCount가 오늘 판정에 그대로 섞여 들어간다. pivotLevelsCache가 이미 쓰던 것과
  // 동일한 패턴(수칙 1-6).
  samples: VwapWatchSample[]; // 최근 N개(추세/거래량 비교용) - approaching·거래량 속도 계산 전용
  hasBeenBelow: boolean; // 감시 시작 후 한 번이라도 VWAP 아래였는지 - 영구 보존(창 밖으로 안 밀려남)
  crossCount: number; // 감시 시작 후 below→above 전환 누적 횟수 - 영구 보존
  wasAbove: boolean | null; // 직전 관측 상태(표본 창이 비워져도 전환 감지가 끊기지 않도록)
  // 🎯 [기능 재설계 - 사용자 요청: "가격 cross → 가격 cross + 일정 시간 유지"] 실시간으로 직접 관측한
  // below→above 전환 시각(ms) - 이 시각으로부터 30초/60초가 지났는지를 재서 reclaimConfirmed/
  // strongReclaim을 판정한다. 감시 시작 전에 이미 돌파해 있었거나(첫 관측이 above) 기준선 아래로
  // 다시 내려가면 즉시 null로 리셋한다(사용자 확정: "30초 동안 아래로 내려가면 즉시 실패/리셋") -
  // null이면 "돌파 시각을 모름"으로 간주해 reclaimed(즉시)만 보여주고 상위 등급은 전부 미확인 처리한다.
  breakoutTs: number | null;
  // 🎯 [기능 추가 - 사용자 요청: "테이블기록 만들자"] approaching/sellPressureWarning이 막 true로
  // 전환된 순간(rising edge)에만 reclaim_signal_events에 기록하기 위한 직전 상태 - 매 15초 폴링마다
  // 중복 기록하지 않는다.
  wasApproaching: boolean;
  wasSellPressure: boolean;
  // 🎯 [기능 추가 - 사용자 요청: "approaching이 나중에 실제 재돌파 성공으로 이어졌는지 outcome을 기록하자"]
  // rising edge에 기록한 reclaim_signal_events 행의 id - falling edge(approaching이 꺼지는 순간)에
  // 그 사이 실제로 뚫었는지(성공) 아니면 힘이 빠져 꺼졌는지(실패)를 판정해 이 id로 UPDATE한다.
  pendingApproachEventId: number | null;
}

// 종목별 최근 표본 이력(감시가 시작된 시점부터 누적) - 프로세스 전역 공유(getGlobalMap, 수칙 1-6).
const vwapWatchHistory = getGlobalMap<string, VwapWatchState>('vwapWatchHistory');
const VWAP_WATCH_MAX_SAMPLES = 20; // 15초 주기 기준 대략 5분 치 이력
// 🚨 [버그 수정 - 사용자 지적: "박스구간 5분 장난해?"] 피봇(R1/R2) 박스 판정은 VWAP과 달리 몇 시간짜리
// 관찰 구간이 필요해서(firstBrokenTs 기반, 아래 computePivotLevelSignal 참고) VWAP_WATCH_MAX_SAMPLES를
// 그대로 재사용하면 안 된다 - 별도 상한을 둔다. 15초 주기로 하루 장중(09:00~15:30, 약 6.5시간)을 넉넉히
// 덮고도 남는 값(약 16시간 분량)이며, 실제 관찰 구간 길이는 여전히 firstBrokenTs가 결정한다 - 이건 그저
// 메모리 무한 증가를 막는 방어용 상한일 뿐 설계 창(window) 크기가 아니다.
const PIVOT_WATCH_MAX_SAMPLES = 4000;

// 🚨 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] VWAP 감시와 피봇 감시가 각자 이 함수를
// 독립적으로 호출해서, 두 감시를 동시에 켜면 같은 종목의 같은 순간 현재가를 KIS에 두 번 물어보는
// 중복이 있었다. 처음엔 5초 dedupe 캐시로 완화를 시도했으나, VWAP watch와 Pivot watch가 서로 다른
// 서버리스 함수(완전히 분리된 메모리)로 배포되는 프로덕션 환경에서는 캐시가 전혀 공유되지 않아 실측상
// 효과가 없었다(로컬 단일 프로세스에서만 통했음). 그래서 이 dedupe 레이어는 제거하고, 대신
// computeReclaimWatchSignal(아래)이 이 함수를 "한 번만" 호출해서 VWAP·피봇 계산에 함께 넘기는
// 구조로 근본 해결했다 - 같은 함수 실행 안에서 값을 공유하므로 서버리스 인스턴스 경계 문제 자체가
// 없다. FHKST01010100(당일 현재가, executeKisDailyPriceFetch와 동일 TR) 1콜로 현재가+누적거래량+
// 누적거래대금을 받아온다. fetchKisDailyPrice의 60초 캐시를 그대로 쓰면 감시 주기(짧으면 10여 초)보다
// 캐시가 더 오래 살아남아 매번 똑같은 값만 보게 되므로, 이 감시 전용 함수는 캐시를 거치지 않고 매번
// 직접 호출한다(3분봉 함수와 동일하게 kisQueue도 거치지 않는다 - 콜당 비용이 가벼워 병렬 처리해도
// 안전함이 실측됨).
async function fetchKisLiveVwapSample(symbol: string): Promise<{ price: number; cumVol: number; cumVal: number } | null> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '') return null;

  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  try {
    const token = await getKisAccessToken();
    if (!token) return null;

    return await fetchWithRetry(async () => {
      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST01010100',
            custtype: 'P',
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`당일 현재가 조회 HTTP ${res.status}`);
        const json = await res.json();
        if (json.rt_cd !== '0' || !json.output) return null;
        const price = parseInt(json.output.stck_prpr || '0', 10);
        const cumVol = parseInt(json.output.acml_vol || '0', 10);
        const cumVal = parseInt(json.output.acml_tr_pbmn || '0', 10);
        if (price <= 0 || cumVol <= 0 || cumVal <= 0) return null;
        return { price, cumVol, cumVal };
      } finally {
        clearTimeout(timeoutId);
      }
    });
  } catch (e: any) {
    console.warn(`[VWAP 실시간 표본 조회 실패] ${symbol}: ${e?.message || e}`);
    return null;
  }
}

// 🎯 [기능 추가 - 사용자 요청: "관심종목으로 누른 종목들 관심종목으로 따로 빼줘"] ws_watchlist(오라클
// 웹소켓 브릿지 구독 대상과 동일 목록)에 담긴 종목들의 실시간 현재가를 랭킹 화면과 동일한 형식으로
// 보여준다. inquire-price 1콜로 현재가/등락률/거래량/거래대금/종목명을 한 번에 받아온다(fetchKisLiveVwapSample과
// 동일 TR 재사용, 수칙 1-6). 최대 41개(웹소켓 세션 구독 한도와 동일 기준)까지 병렬 조회해도 안전함이
// 이전 실측(program-trade 등 단일 인콰이어리 콜 90개 병렬 테스트, 500 폭주 없었음)으로 확인됨.
export async function fetchKisWatchlistQuotes(symbols: string[]): Promise<RankingItem[]> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '' || symbols.length === 0) return [];

  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  const token = await getKisAccessToken();
  if (!token) return [];

  const results = await Promise.all(
    symbols.map(async (symbol): Promise<RankingItem | null> => {
      try {
        return await fetchWithRetry(async () => {
          const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          try {
            const res = await fetch(url, {
              method: 'GET',
              headers: {
                'content-type': 'application/json; charset=utf-8',
                authorization: `Bearer ${token}`,
                appkey: appKey,
                appsecret: appSecret,
                tr_id: 'FHKST01010100',
                custtype: 'P',
              },
              cache: 'no-store',
              signal: controller.signal,
            });
            if (!res.ok) throw new Error(`관심종목 현재가 조회 HTTP ${res.status}`);
            const json = await res.json();
            if (json.rt_cd !== '0' || !json.output) return null;
            const o = json.output;
            const currentPrice = parseInt(o.stck_prpr || '0', 10);
            if (currentPrice <= 0) return null;
            const changeSign = o.prdy_vrss_sign === '5' || o.prdy_vrss_sign === '4' ? -1 : 1;
            const change = changeSign * Math.abs(parseInt(o.prdy_vrss || '0', 10));
            const changeRate = parseFloat(o.prdy_ctrt || '0');
            const volume = parseInt(o.acml_vol || '0', 10);
            const amountEok = parseInt(o.acml_tr_pbmn || '0', 10) / 100000000;
            const name = o.hts_kor_isnm || getStockName(symbol);
            return {
              rank: 0, // 아래에서 등락률 기준으로 재배정
              symbol,
              name,
              currentPrice,
              change,
              changeRate: isNaN(changeRate) ? 0 : changeRate,
              netBuyQty: 0,
              netBuyAmt: 0,
              netBuyAmtEok: 0,
              volume,
              ratioVsVolume: 0,
              amountEok,
              openPrice: parseInt(o.stck_oprc || '0', 10),
              highPrice: parseInt(o.stck_hgpr || '0', 10),
              lowPrice: parseInt(o.stck_lwpr || '0', 10),
            };
          } finally {
            clearTimeout(timeoutId);
          }
        });
      } catch (e: any) {
        console.warn(`[관심종목 현재가 조회 실패] ${symbol}: ${e?.message || e}`);
        return null;
      }
    })
  );

  return results
    .filter((r): r is RankingItem => r !== null)
    .sort((a, b) => b.changeRate - a.changeRate)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));
}

// 🚨 [임계값 조정 - 사용자 지적: "지금도 다 재돌파 완료만 떠있어"] 원래 0.5%였던 "임박" 판정 폭이
// 15초 폴링 주기 대비 너무 좁았다 - 실측(로컬, reclaim-watch API 직접 호출): 현대약품(004310) R1이
// 이미 reclaimed:true/approaching:false였고, 같은 종목 3분봉이 10:30→10:33 사이에만 +0.84%
// (10700원→10790원, 거래량 111,812주) 움직였다. 이 정도 속도면 0.5% 구간은 폴링 한두 틱 만에
// 통과해버려 "임박" 상태가 관측될 확률 자체가 구조적으로 낮았다 - 그래서 항상 "완료"만 보였던 것.
// 사용자 확인 후 1.5%로 상향.
const APPROACHING_GAP_THRESHOLD_PCT = 1.5;

interface ApproachSample {
  ts: number; // 🎯 [기능 추가 - 사용자 요청: "현재 rate / baseline rate / 오늘 평균 rate를 전부 로깅"]
  // 시간당(60초 환산) 거래량 속도를 계산하려면 실제 체결 시각이 필요하다 - 원래 이 필드가 빠져 있어서
  // computeVolumeRate(시간 윈도우 기반, computeReclaimFreshness가 이미 쓰던 것)를 재사용하지 못하고
  // "최근 표본 2개 vs 그 이전 표본들"이라는 표본 개수 기반의 별도 근사 로직이 따로 있었다(수칙 1-6).
  price: number;
  cumVol: number;
  target: number; // VWAP은 표본마다 그 시점의 VWAP 값(변동), 피봇은 고정된 R1/R2 값(불변)
}

// 🎯 [기능 재설계 - 사용자 요청: "거래량 증가 = 활동성, 매수 우위 = 방향성 둘 다 보게 - 거래량↑ + 매수
// 우위 → 재돌파 임박, 거래량↑ + 매도 우위 → 임박에서 제외하고 매도 압박으로 표시"] 틱 테스트(Tick Test) -
// 직전 표본보다 가격이 올랐으면 그 구간에 체결된 거래량을 매수 쪽으로, 내렸으면 매도 쪽으로 분류한다.
// 호가창(매수/매도 잔량) 데이터 없이 기존에 이미 갖고 있는 표본(price, cumVol)만으로 계산 가능한 표준
// 근사법이다. 가격이 안 변한 구간은 직전 방향을 그대로 이어받는다(Tick Test의 통상적인 처리 방식).
function computeVolumeDirection(samples: ApproachSample[]): { buyVolume: number; sellVolume: number } {
  let buyVolume = 0;
  let sellVolume = 0;
  let lastDirection: 1 | -1 = 1; // 첫 구간에서 가격 변화가 없으면 매수로 간주(보수적 기본값)
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].cumVol - samples[i - 1].cumVol;
    if (delta <= 0) continue;
    if (samples[i].price > samples[i - 1].price) lastDirection = 1;
    else if (samples[i].price < samples[i - 1].price) lastDirection = -1;
    if (lastDirection === 1) buyVolume += delta; else sellVolume += delta;
  }
  return { buyVolume, sellVolume };
}

interface ApproachResult {
  approaching: boolean;
  sellPressureWarning: boolean; // 거래량은 늘었지만 매도 우위라 임박에서 제외된 경우(참고용 경고)
  buyVolume: number; // 로깅용(reclaim_signal_events) - 판정에 쓰인 매수 방향 거래량
  sellVolume: number; // 로깅용 - 판정에 쓰인 매도 방향 거래량
  // 🎯 [기능 추가 - 사용자 요청: "절대 활성도 게이트는 지금 숫자를 임의로 박지 말고, 현재 rate / baseline
  // rate / 오늘 평균 rate를 전부 로깅해서 데이터 쌓은 뒤 임계값을 정하자"] 세 값 모두 판정(approaching/
  // sellPressureWarning)에는 아직 쓰지 않는다 - reclaim_signal_events에 기록만 해서, 나중에 실제 재돌파
  // 성공/실패 데이터와 대조해 절대 활성도 기준과 시간대 프로파일을 데이터 기반으로 정한다.
  recentRate: number | null; // 최근 60초 거래량 속도(60초 환산)
  baselineRate: number | null; // 그 직전 60초 거래량 속도(60초 환산) - 표본 이력이 120초 미만이면 null(미확인)
  todayAvgRate: number | null; // 오늘 09:00 장시작부터 지금까지의 누적 평균 거래량 속도(60초 환산)
}
const NO_APPROACH: ApproachResult = { approaching: false, sellPressureWarning: false, buyVolume: 0, sellVolume: 0, recentRate: null, baselineRate: null, todayAvgRate: null };

// "근접 중"(간격 좁혀짐 + 임박 폭 이내 + 거래량 선행 증가 + 매수 우위) 판정 - VWAP과 피봇(R1/R2) 양쪽에서
// 완전히 동일한 로직이 각자 인라인으로 중복돼 있던 것을 하나로 합쳤다(수칙 1-6).
// 🚨 [버그 수정 - 사용자 지적: "지금 알고리즘의 volPickup은 '거래가 붙었다'만 말하고 있어서, 재돌파 임박
// 판정의 방향성 정보가 없어 - 매도 우위인데 거래량만 급증한 종목은 임박 상태를 아예 띄우지 않는거 어때?
// 지금 찾는게 '거래량 많은 종목'이 아니라 '재돌파할 가능성이 높은 종목'이니까"] volPickup(활동성)은 그대로
// 두고, 그 증가분이 매수 쪽인지 매도 쪽인지(방향성)를 추가로 확인한다. 매수/매도 판정 임계값은 "매수
// 60% 이상"처럼 임의로 세게 고정하지 않고(사용자 확정: "처음부터 정하기보다는 과거 데이터를 돌려서
// 임계값을 찾는 게 낫겠어") 수학적으로 중립적인 단순 과반(매수량 > 매도량)만 본다 - 이 판정이 일어나는
// 순간마다 buyVolume/sellVolume을 reclaim_signal_events에 기록해서(호출부 참고), 나중에 실제 결과와
// 대조해 이 임계값을 데이터 기반으로 조정할 수 있게 한다(사용자 요청: "테이블기록 만들자").
function computeApproachingSignal(samples: ApproachSample[]): ApproachResult {
  if (samples.length < 5) return NO_APPROACH;
  const first = samples[samples.length - 5];
  const latest = samples[samples.length - 1];
  const gapNow = latest.target - latest.price;
  const gapFirst = first.target - first.price;
  const stillBelow = gapNow > 0;
  const narrowing = gapFirst > gapNow;
  const gapPct = latest.target ? (gapNow / latest.target) * 100 : 100;
  const isImminent = stillBelow && gapPct <= APPROACHING_GAP_THRESHOLD_PCT;

  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i++) deltas.push(samples[i].cumVol - samples[i - 1].cumVol);
  const recentAvg = deltas.slice(-2).reduce((a, b) => a + b, 0) / Math.min(2, deltas.length);
  const priorDeltas = deltas.slice(0, Math.max(0, deltas.length - 2));
  const priorAvg = priorDeltas.length > 0 ? priorDeltas.reduce((a, b) => a + b, 0) / priorDeltas.length : 0;
  const volPickup = priorAvg > 0 && recentAvg > priorAvg;

  if (!stillBelow || !narrowing || !isImminent || !volPickup) return NO_APPROACH;

  // volPickup을 만든 바로 그 구간(최근 2개 델타 = 최근 3표본)의 매수/매도 방향을 확인한다.
  const recentSamples = samples.slice(-3);
  const { buyVolume, sellVolume } = computeVolumeDirection(recentSamples);
  if (buyVolume + sellVolume === 0) return NO_APPROACH; // 방향 판단 불가 - 임박도 매도압박도 단정하지 않음

  // 🎯 [기능 추가 - 사용자 요청: "지금 거래량도 적은데 임박이 너무 남발이야 - 절대 활성도 게이트는 지금
  // 숫자를 임의로 박지 말고, rate 3종을 전부 로깅해서 데이터 쌓은 뒤 임계값을 정하자"] 판정(approaching/
  // sellPressureWarning)은 위 volPickup(상대 비교)을 그대로 쓰고 바꾸지 않는다 - 아래 세 값은 오직
  // reclaim_signal_events 로깅용이다. computeReclaimFreshness의 volSurge와 동일한 시간 윈도우 방식
  // (computeVolumeRate 재사용, 수칙 1-6)이라 "표본 개수" 기반이던 volPickup보다 훨씬 정직한 속도값이다.
  const recentWindowStart = latest.ts - VOLUME_BASELINE_WINDOW_MS;
  const recentRate = computeVolumeRate(samples, recentWindowStart, latest.ts);
  const baselineWindowStart = latest.ts - 2 * VOLUME_BASELINE_WINDOW_MS;
  const baselineSufficient = samples[0].ts <= baselineWindowStart;
  const baselineRate = baselineSufficient ? computeVolumeRate(samples, baselineWindowStart, recentWindowStart) : null;
  const marketOpenTs = getKstMarketOpenTs(latest.ts);
  const todayAvgRate = latest.ts > marketOpenTs ? (latest.cumVol / (latest.ts - marketOpenTs)) * 60_000 : null;

  if (buyVolume > sellVolume) return { approaching: true, sellPressureWarning: false, buyVolume, sellVolume, recentRate, baselineRate, todayAvgRate };
  return { approaching: false, sellPressureWarning: true, buyVolume, sellVolume, recentRate, baselineRate, todayAvgRate }; // 거래량은 늘었지만 매도 우위 - 임박 아님
}

// 표본 하나를 새로 받아와 이력에 추가하고, 그 이력으로 재돌파/임박/2차시도를 판정한다. 3분봉 버전과
// 판정 로직의 "의미"는 동일(간격 좁혀짐+임박 폭 이내+거래량 선행 증가 → 임박, below→above 전환 후 유지 →
// 재돌파)하지만, 매 표본이 그 시점의 완결된 실측값이라 "진행 중인 봉" 문제(KEC 깜빡임 버그) 자체가 없다.
//
// 🚨 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"에 대한 답] live 샘플을 파라미터로 받는 내부
// 함수로 분리했다 - VWAP 감시와 피봇 감시가 원래 각자 fetchKisLiveVwapSample을 "따로" 호출해서, 두
// 감시를 동시에 켜면 같은 종목의 같은 순간 현재가를 KIS에 두 번 물어보는 근본적 중복이 있었다. 5초
// dedupe 캐시로 완화를 시도했지만, 실측(프로덕션) 결과 두 감시가 서로 다른 서버리스 함수(완전히 분리된
// 메모리)라 캐시가 전혀 공유되지 않아 효과가 없었다 - 로컬(단일 프로세스)에서만 통했던 셈이다. 진짜
// 해법은 "같은 함수 안에서 한 번만 조회해서 같이 쓰는 것" - 아래 computeReclaimWatchSignal이 live를
// 한 번만 fetch해서 이 함수와 computePivotSignalFromLive에 함께 넘긴다.
// ============================================================================
// 🎯 [기능 재설계 - 사용자 요청: "재돌파 임박 → 재돌파 확인(방금 발생, 힘 확인 중) → 돌파 완료(유지 중)
// → 완료 후 5분 경과(오래된 이벤트) - 이런 신호의 신선도를 넣어"] 가격은 재돌파 판정의 본체, 거래량은
// 재돌파의 신뢰도 - 거래량을 게이팅 조건으로 쓰지 않는다(사용자 확정). VWAP·피봇(R1/R2) 양쪽에서 완전히
// 동일한 판정 로직이 중복되지 않도록 공용 함수로 뺐다(수칙 1-6).
//
// 사용자 확정 수치(2026-09-18 대화에서 직접 지정, 임의 매직넘버 아님):
//   - 30초 미만: "재돌파 확인"(방금 발생했고 아직 힘 확인 중)
//   - 30초~5분: "돌파 완료"(유지 중)
//   - 5분 이상: "완료 후 5분 경과"(더 오래된 이벤트)
//   - 30초 동안 기준선 아래로 다시 내려가면 즉시 실패/리셋(breakoutTs를 null로 되돌림)
//   - 거래량 baseline = 돌파 전 60초 구간의 시간당(60초 환산) 거래량 속도, 최근 60초와 롤링 비교
// ============================================================================
const RECLAIM_CONFIRM_HOLD_MS = 30_000;
const RECLAIM_STALE_MS = 5 * 60_000;
const VOLUME_BASELINE_WINDOW_MS = 60_000;

// 표본 배열에서 [fromTs, toTs] 구간의 "60초 환산 거래량 속도"를 구한다. 표본은 15초 폴링마다 실제
// 체결(cumVol 증가)이 있을 때만 쌓이므로 간격이 균일하지 않다 - 그래서 표본 "개수"가 아니라 표본에
// 실제로 찍힌 타임스탬프(ts)로 구간을 잘라 시간당 속도로 환산한다(사용자 확정: "표본 개수가 아니라
// 실제 시간당 거래량으로 계산").
function computeVolumeRate(samples: Array<{ ts: number; cumVol: number }>, fromTs: number, toTs: number): number {
  if (samples.length === 0 || toTs <= fromTs) return 0;
  const cumVolAt = (t: number) => {
    let result = samples[0].cumVol;
    for (const s of samples) {
      if (s.ts > t) break;
      result = s.cumVol;
    }
    return result;
  };
  const delta = cumVolAt(toTs) - cumVolAt(fromTs);
  return (delta / (toTs - fromTs)) * 60_000;
}

interface ReclaimFreshnessResult {
  elapsedMs: number | null;
  volSurge: boolean;
}

const EMPTY_RECLAIM_FRESHNESS: ReclaimFreshnessResult = { elapsedMs: null, volSurge: false };

// breakoutTs(관측된 below→above 전환 시각, 또는 "감시를 시작했을 때 이미 위였던" 첫 관측 시각을
// 하한으로 삼은 값 - 아래 상태 갱신 로직 참고)로부터 지금까지 얼마나 지났는지를 신선도(elapsedMs)로
// 반환한다. breakoutTs는 currentlyAbove인 한 절대 null이 아니다(상태 갱신 로직이 항상 채워준다) -
// "타이밍을 몰라서 확인불가"라는 상태 자체를 없앴다(사용자 지적: "뭔 다 확인 불가라고 떠?").
function computeReclaimFreshness(samples: Array<{ ts: number; cumVol: number }>, breakoutTs: number | null, currentlyAbove: boolean): ReclaimFreshnessResult {
  if (!currentlyAbove || breakoutTs === null) return EMPTY_RECLAIM_FRESHNESS;

  // 🚨 [버그 수정 - 사용자 지적: "가격만 보면 재돌파처럼 보이는데, 거래가 너무 느려서 의미 없는 움직임까지
  // 신호로 잡고 있는 것같아"] 예전엔 elapsedMs를 Date.now()(벽시계 경과시간) 기준으로 쟀다 - 거래가
  // 뜸한 종목은 돌파 순간 딱 1틱만 체결되고 그 뒤 20분 동안 재체결이 전혀 없어도 "20분째 유지 중"이라고
  // 표시됐다(실제로는 그 20분 동안 아무 것도 재확인되지 않았다). "지금"을 벽시계가 아니라 "가장 최근에
  // 실제로 체결된 시각"으로 바꿨다 - 재체결이 없으면 elapsedMs가 그대로 멈춰서, 진짜 거래로 재확인된
  // 시간만 신선도로 인정한다(30초/5분 문턱도 이제 "실제 거래 시간"으로 재는 셈).
  const now = samples.length > 0 ? samples[samples.length - 1].ts : breakoutTs;
  const elapsedMs = now - breakoutTs;

  // baseline 구간(돌파 전 60초)이 실제로 표본에 다 담겨있는지 확인 - 감시를 시작한 지 60초가 안 된
  // 채로 바로 돌파가 나오면 baseline을 정직하게 잴 수 없으므로, 이 경우엔 volSurge를 false(미확인)로
  // 둔다(과대/과소평가된 baseline으로 거짓 신호를 만들지 않기 위함).
  const earliestTs = samples.length > 0 ? samples[0].ts : breakoutTs;
  const baselineStart = breakoutTs - VOLUME_BASELINE_WINDOW_MS;
  const baselineSufficient = earliestTs <= baselineStart;
  const baselineRate = baselineSufficient ? computeVolumeRate(samples, baselineStart, breakoutTs) : 0;

  // 최근 60초(또는 돌파 이후 전체 구간, 더 짧은 쪽) 속도 vs baseline - 매 폴링마다 롤링 재계산되므로
  // 30초 시점에 한 번 확인하고 끝나는 게 아니라 계속 최신 상태를 반영한다.
  const recentWindowStart = Math.max(breakoutTs, now - VOLUME_BASELINE_WINDOW_MS);
  const recentRate = computeVolumeRate(samples, recentWindowStart, now);
  const volSurge = baselineSufficient && baselineRate > 0 && recentRate > baselineRate;

  return { elapsedMs, volSurge };
}

async function computeVwapSignalFromLive(symbol: string, live: { price: number; cumVol: number; cumVal: number } | null): Promise<VwapReclaimSignal> {
  const fallback: VwapReclaimSignal = { symbol, signal: false, reclaimed: false, elapsedMs: null, volSurge: false, approaching: false, sellPressureWarning: false, hadPriorReclaim: false, crossCount: 0, insufficientData: true };
  if (!live) return fallback;

  const vwap = live.cumVal / live.cumVol;
  const todayStr = getKstTodayStr();
  let state = vwapWatchHistory.get(symbol);
  if (!state || state.dateStr !== todayStr) {
    // 🚨 [버그 수정 - 사용자 지적: "저걸 어떻게 고치지" (재시작/서버리스 콜드스타트에 플래그 유실)]
    // 이 프로세스에서 이 심볼을 아직 한 번도 감시 안 한 시점(맵에 없음)이거나, 날짜가 바뀐 시점(맵에는
    // 있지만 어제자 - 코드 리뷰에서 발견된 자정 경계 미처리 버그 수정) - 오늘자로 이미 Supabase에
    // 저장된 플래그가 있으면 그걸로 복구하고, 없으면(진짜 처음이거나 Supabase 미설정) 빈 상태로 시작.
    const persisted = await fetchWatchSignalState(todayStr, symbol);
    state = { dateStr: todayStr, samples: [], hasBeenBelow: persisted?.vwapHasBeenBelow ?? false, crossCount: persisted?.vwapCrossCount ?? 0, wasAbove: null, breakoutTs: null, wasApproaching: false, wasSellPressure: false, pendingApproachEventId: null };
  }

  const lastStoredSample = state.samples[state.samples.length - 1];
  // 누적거래량이 실제로 늘어난 새 체결일 때만 표본으로 기록 - 체결 없이 호가만 바뀐 중복 조회 방지.
  if (!lastStoredSample || live.cumVol > lastStoredSample.cumVol) {
    const prevHasBeenBelow = state.hasBeenBelow;
    const prevCrossCount = state.crossCount;
    const isAboveNow = live.price > vwap;
    // 🚨 [버그 수정 - 사용자 지적: "뭔 다 확인 불가라고 떠?"] wasAbove가 false(진짜 below→above 전환)일
    // 때뿐 아니라, null(이 프로세스에서 이 심볼을 처음 관측하는 순간인데 이미 위인 경우 - 감시를 늦게
    // 켰거나 서버가 막 재시작된 흔한 경우)에도 breakoutTs를 지금 시각으로 잡는다. 실제 돌파는 더 일찍
    // 일어났을 수 있어 elapsedMs가 진짜 유지시간보다 짧게(하한으로) 나올 수는 있지만, 시간이 지날수록
    // 계속 자라나므로 "확인불가"에 영원히 갇히지 않는다(단, crossCount는 진짜 전환일 때만 증가).
    const isFreshAboveObservation = (state.wasAbove === false || state.wasAbove === null) && isAboveNow;
    if (state.wasAbove === false && isAboveNow) state.crossCount++;
    if (isFreshAboveObservation) state.breakoutTs = Date.now();
    if (!isAboveNow) {
      state.hasBeenBelow = true;
      state.breakoutTs = null; // 기준선 아래로 내려가면 진행 중이던 시도는 즉시 무효(사용자 확정)
    }
    state.wasAbove = isAboveNow;

    state.samples.push({ ts: Date.now(), price: live.price, cumVol: live.cumVol, vwap });
    if (state.samples.length > VWAP_WATCH_MAX_SAMPLES) state.samples.shift();
    vwapWatchHistory.set(symbol, state);

    // 플래그가 "실제로 바뀐" 순간에만 영구 저장한다 - 매 15초 폴링마다 쓰면 낭비이므로, 대부분의
    // 폴링(값 변화 없음)에서는 Supabase에 아무것도 쓰지 않는다. fire-and-forget(응답 지연 없음).
    if (state.hasBeenBelow !== prevHasBeenBelow || state.crossCount !== prevCrossCount) {
      upsertWatchSignalState(todayStr, symbol, { vwapHasBeenBelow: state.hasBeenBelow, vwapCrossCount: state.crossCount }).catch(() => {});
    }
  }

  if (state.samples.length < 2) return { ...fallback, insufficientData: true };

  const isAbove = (s: VwapWatchSample) => s.price > s.vwap;
  const latest = state.samples[state.samples.length - 1];
  const currentlyAbove = isAbove(latest);
  const reclaimed = currentlyAbove && state.hasBeenBelow; // 즉시(가격만) - 기존과 동일한 정의, 회귀 없음
  const hadPriorReclaim = state.crossCount >= 2;

  const freshness = computeReclaimFreshness(state.samples, state.breakoutTs, reclaimed);

  const approach = computeApproachingSignal(
    state.samples.map((s) => ({ ts: s.ts, price: s.price, cumVol: s.cumVol, target: s.vwap }))
  );

  // 🎯 [기능 추가 - 사용자 요청: "테이블기록 만들자"] approaching/sellPressureWarning으로 막 전환된
  // 순간(rising edge)에만 1행 기록한다 - fire-and-forget(응답 지연 없음). approaching은 insert된 행의
  // id를 기억해뒀다가, 이 approaching이 꺼지는 순간(falling edge, 바로 아래) outcome을 채워 넣는다.
  if (approach.approaching && !state.wasApproaching) {
    logReclaimSignalEvent({ date: todayStr, symbol, levelType: 'vwap', eventType: 'approaching', price: latest.price, target: latest.vwap, buyVolume: approach.buyVolume, sellVolume: approach.sellVolume, recentRate: approach.recentRate, baselineRate: approach.baselineRate, todayAvgRate: approach.todayAvgRate })
      .then((id) => { state.pendingApproachEventId = id; })
      .catch(() => {});
  } else if (approach.sellPressureWarning && !state.wasSellPressure) {
    logReclaimSignalEvent({ date: todayStr, symbol, levelType: 'vwap', eventType: 'sell_pressure', price: latest.price, target: latest.vwap, buyVolume: approach.buyVolume, sellVolume: approach.sellVolume, recentRate: approach.recentRate, baselineRate: approach.baselineRate, todayAvgRate: approach.todayAvgRate }).catch(() => {});
  } else if (!approach.approaching && state.wasApproaching && state.pendingApproachEventId !== null) {
    // 🎯 [기능 추가 - 사용자 요청: "outcome을 지금 같이 추가하자"] approaching은 정의상 가격이 기준선을
    // 넘는 순간(stillBelow=false) 즉시 꺼진다 - 그래서 falling edge 시점의 currentlyAbove만 보면 "그
    // approaching 시도가 실제 돌파로 이어졌는지(success)"와 "힘이 빠져 그냥 꺼졌는지(failed)"가 별도
    // 대기시간 없이 정확히 갈린다(사용자 확정: "임의 숫자 새로 만들지 말자").
    updateReclaimSignalOutcome(state.pendingApproachEventId, currentlyAbove ? 'success' : 'failed').catch(() => {});
    state.pendingApproachEventId = null;
  }
  state.wasApproaching = approach.approaching;
  state.wasSellPressure = approach.sellPressureWarning;

  return {
    symbol,
    signal: freshness.elapsedMs !== null && freshness.elapsedMs >= RECLAIM_CONFIRM_HOLD_MS && freshness.volSurge,
    reclaimed,
    elapsedMs: freshness.elapsedMs,
    volSurge: freshness.volSurge,
    approaching: approach.approaching,
    sellPressureWarning: approach.sellPressureWarning,
    hadPriorReclaim,
    crossCount: state.crossCount,
    insufficientData: false,
  };
}

// 화면에 보이는 후보 전부를 한 번에 갱신 - 콜당 비용이 가벼워졌으므로(14콜→1콜) 5개로 좁힐 필요 없이
// 병렬로 한꺼번에 처리한다. 최대 60개(급등주 탭 기준 실제 표시 개수)로만 안전 상한을 둔다.
// 🚨 [버그 수정 - 실측: 서버 재시작 직후 VWAP+피봇 두 감시를 동시에 켰더니 최대 120개 요청이 한꺼번에
// 몰려서 일부가 "당일 현재가 조회 HTTP 500"으로 실패함] 종목당 비용이 14콜→1콜로 가벼워졌다고 해서
// 청크 없이 전부 Promise.all 해도 되는 건 아니었다 - 검증된 안전 범위(14~70개)를 넘어설 수 있다.
// 🚨 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] VWAP 감시와 피봇 감시를 아예 하나의 API
// (computeReclaimWatchSignal)로 합쳐서, "두 감시를 동시에 켜면 서로 다른 함수가 동시에 KIS를
// 두들겨서 120개가 몰린다"는 시나리오 자체가 구조적으로 사라졌다 - 이제 요청은 항상 하나뿐이고, 종목당
// 최대 2콜(현재가+피봇 일봉 캐시미스시)이 30개씩 청크 처리되므로 한 라운드 최대 동시 요청은 60개로,
// 검증된 안전 범위 안이다(실측: 서버 재시작 직후 재현 테스트로 500 에러 없음 확인, 수칙 2-8). 30개씩
// 묶어서 순차 처리한다.
async function runInChunks<T, R>(items: T[], chunkSize: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(worker));
    results.push(...chunkResults);
  }
  return results;
}

// ============================================================================
// 🎯 [기능 추가 - 사용자 요청: "R2까지 안가고 R1까지 뚫었어도 괜찮아... 손절선에 가도 괜찮아... 다시
// 올라올거 같은 반등"] 전일 확정 일봉 기준 고정 피봇 저항선(R1·R2)을 뚫었다가(깊이 상관없이) 다시 그
// 선을 향해 올라오는 종목을 잡는다. VWAP과 판정 로직(뚫림→눌림→재도전, 간격 좁혀짐+거래량 선행)은
// 동일하지만, R1/R2는 전일 일봉 기준으로 하루 종일 고정된 값이라 VWAP처럼 매 표본마다 다시 계산할
// 필요가 없다 - 종목당 하루 1번만 계산해서 캐시해두고(fetchKisInvestorTrend 재사용, 새 KIS TR 없음,
// 수칙 1-6), 이미 VWAP 감시 루프가 매번 받아오는 현재가(fetchKisLiveVwapSample)를 그대로 같이 써서
// 추가 KIS 호출 없이 판정한다.

interface PivotLevels {
  r1: number;
  r2: number;
}

interface PivotSample {
  ts: number;
  price: number;
  cumVol: number;
}

// 🚨 [재설계 - 사용자 지적: "저렇게 박스를 하는게 내가 3분봉 보고 매매에 대해 도움이 되나? 나는 내
// 매매에 도움이 되는 박스를 형성에서 거기에 맞게 뱃지를먹여서 박스권 하락, 박스권 돌파 이런걸
// 원했던건데... 순위표 배지로"] R1/R2 선 대비 박스 판정(옛 BOX_RANGE_THRESHOLD_PCT/BOX_MIN_SAMPLES/
// firstBrokenTs 기반, computePivotLevelSignal 안에 있었음)은 완전히 폐기한다 - 레벨(R1/R2)마다 따로
// 판정해서 화면에 "R1 돌파박스구간"처럼 나왔는데, 사용자가 실제로 원한 건 종목 하나에 대해 "지금 박스권
// 유지/돌파/하락 중" 딱 하나의 상태였다. RankingStockDetailChart.tsx(3분봉 차트)가 쓰는
// detectChartLegsInDay와 동일한 알고리즘(수칙 1-6 - 박스는 방향성 필터로 추세와 구분, 박스 아닌 구간은
// 상승/하락으로 채움)을, 캔들이 아니라 이미 이 감시 루프가 15초마다 모으고 있는 실시간 가격 표본
// (PivotSample)에 적용한다 - 새 KIS 호출 없이(수칙 1-3) 기존 인프라 그대로 재사용.
const PRICE_LEG_RANGE_THRESHOLD_PCT = 2.0; // RankingStockDetailChart.tsx의 BOX_DETECT_RANGE_THRESHOLD_PCT와 동일(수칙 1-6, 미검증 휴리스틱 - 수칙 1-7)
const PRICE_LEG_DIRECTIONAL_RATIO_MAX = 0.5; // 동일 파일의 BOX_DIRECTIONAL_RATIO_MAX와 동일
const PRICE_LEG_MIN_SAMPLES = 60; // 15초×60=15분 - 차트의 BOX_DETECT_MIN_CANDLES(3분×5=15분)와 동일 기준

interface PriceLeg {
  type: 'box' | 'up' | 'down';
  high: number;
  low: number;
  startIdx: number;
  endIdx: number;
}

// 실시간 가격 표본(samples, 오름차순)을 훑어 박스/상승/하락 구간으로 빈틈없이 나눈다 - 개별 표본은
// 캔들과 달리 시가/종가 구분이 없는 점(点)이라 몸통(body) 개념 자체가 없고, 표본 가격을 그대로 쓰면
// 캔들의 "꼬리 문제"도 원천적으로 없다.
function detectPriceLegsFromSamples(samples: PivotSample[]): PriceLeg[] {
  const legs: PriceLeg[] = [];
  if (!samples || samples.length === 0) return legs;
  const boxes: Array<{ high: number; low: number; startIdx: number; endIdx: number }> = [];
  let start = 0;
  let hi = samples[0].price;
  let lo = samples[0].price;
  const tryPushBox = (s: number, e: number, h: number, l: number) => {
    if (e - s + 1 < PRICE_LEG_MIN_SAMPLES) return;
    const range = h - l;
    const netMove = Math.abs(samples[e].price - samples[s].price);
    if (range > 0 && netMove / range > PRICE_LEG_DIRECTIONAL_RATIO_MAX) return; // 왔다갔다가 아니라 한 방향으로 쭉 간 구간
    boxes.push({ high: h, low: l, startIdx: s, endIdx: e });
  };
  for (let i = 1; i < samples.length; i++) {
    const nextHi = Math.max(hi, samples[i].price);
    const nextLo = Math.min(lo, samples[i].price);
    const mid = (nextHi + nextLo) / 2;
    const rangePct = mid > 0 ? ((nextHi - nextLo) / mid) * 100 : 0;
    if (rangePct <= PRICE_LEG_RANGE_THRESHOLD_PCT) {
      hi = nextHi;
      lo = nextLo;
      continue;
    }
    tryPushBox(start, i - 1, hi, lo);
    start = i;
    hi = samples[i].price;
    lo = samples[i].price;
  }
  tryPushBox(start, samples.length - 1, hi, lo);

  // 박스 사이(또는 앞뒤) 빈틈을 상승/하락 추세 구간으로 채워서 표본 전체가 항상 셋 중 하나로 분류되게 한다.
  let cursor = 0;
  const pushTrendLeg = (s: number, e: number) => {
    if (e < s) return;
    let h = samples[s].price;
    let l = samples[s].price;
    for (let k = s + 1; k <= e; k++) {
      h = Math.max(h, samples[k].price);
      l = Math.min(l, samples[k].price);
    }
    legs.push({ type: samples[e].price >= samples[s].price ? 'up' : 'down', high: h, low: l, startIdx: s, endIdx: e });
  };
  for (const box of boxes) {
    if (box.startIdx > cursor) pushTrendLeg(cursor, box.startIdx - 1);
    legs.push({ type: 'box', high: box.high, low: box.low, startIdx: box.startIdx, endIdx: box.endIdx });
    cursor = box.endIdx + 1;
  }
  if (cursor <= samples.length - 1) pushTrendLeg(cursor, samples.length - 1);
  return legs;
}

// 종목별 R1/R2 값 - 전일 일봉이 바뀌지 않는 한(즉 오늘 하루 종일) 그대로 재사용(프로세스 전역, 수칙 1-6).
const pivotLevelsCache = getGlobalMap<string, { dateStr: string; levels: PivotLevels }>('pivotLevelsCache');

async function getPivotLevelsForSymbol(symbol: string): Promise<PivotLevels | null> {
  const todayStr = getKstTodayStr();
  const cached = pivotLevelsCache.get(symbol);
  if (cached && cached.dateStr === todayStr) return cached.levels;

  try {
    // 🚨 [성능 개선 - 사용자 지적: "피봇 재돌파 감시 되게 오래걸리는데? 금방 뜨는것들도 있지만 오래
    // 걸리는 애들도 있어"] 원래는 fetchKis3mCandlesFullDay의 피봇 계산 블록과 맞춰 fetchKisInvestorTrend
    // (365일치+수급+프로그램매매까지 최대 5회 순차 KIS 호출, 위 1730번째 줄 주석에 콜드 상태 실측
    // 15~40초라고 이미 적혀있음)를 재사용했었다 - 그래서 그날 처음 조회하는(캐시 미스) 종목만 15~40초씩
    // 걸리고 이미 캐시된 종목은 빨리 뜨는 게 "일부는 금방, 일부는 오래" 증상의 실제 원인이었다.
    // R1/R2 계산에 필요한 건 "직전 확정 거래일의 고가/저가/종가" 3개 숫자뿐이라, 바로 위 "장마감 후보만"
    // 기능이 동일한 문제를 이미 fetchKisRecentDailyBars(inquire-daily-itemchartprice 단 1회 호출)로
    // 풀어뒀던 것을 그대로 재사용한다(수칙 1-6 - 새 KIS 호출/새 TR 추가 없음).
    //
    // 🚨 [성능 개선 - 사용자 지적: "피봇감시는 왜 바로 안뜨고 로딩이 걸리는거야? 시간 못줄이나"] 그런데
    // fetchKisRecentDailyBars(공용 래퍼)는 kisQueue.enqueue(LOW, 최소 200ms 간격)로 완전 직렬화된다.
    // 피봇 워치는 이미 자체적으로 20개씩 청크 병렬 처리(runInChunks) 중인데, 그 안에서 다시 캐시 미스인
    // 종목들이 kisQueue로 한 줄로 서서 하나씩 처리되면 20개면 최소 4초, 60개 전부 미스면 최소 12초가
    // 그대로 더해진다(실측: 프로덕션 60종목 12.8초 - 200ms×60=12초와 정확히 일치). "장마감 후보만"은
    // 백그라운드성이라 이 지연이 문제없지만 피봇 워치는 실시간성이 핵심이라 못 견딘다. 순수 fetch 로직
    // (executeKisRecentDailyBarsFetch, 큐 미사용)을 큐 없이 직접 호출하되, 캐시(recentDailyBarsCache)는
    // "장마감 후보만"과 그대로 공유해서 중복 라이브 호출을 막는다 - VWAP 감시의 fetchKisLiveVwapSample이
    // 동일한 이유로 이미 큐를 안 쓰는 선례가 있다(수칙 1-6, 캐시는 공유하되 동시성 정책만 분리).
    const dailyBarsCached = recentDailyBarsCache.get(symbol);
    let bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }> | undefined;
    if (dailyBarsCached && Date.now() - dailyBarsCached.timestamp < getDynamicRankingTtl()) {
      bars = dailyBarsCached.data;
    } else {
      bars = await fetchWithRetry(() => executeKisRecentDailyBarsFetch(symbol));
      if (bars && bars.length > 0) {
        recentDailyBarsCache.set(symbol, { data: bars, timestamp: Date.now() });
      }
    }
    if (!bars || bars.length === 0) return null;

    const pastDailies = bars.filter((b) => b.date !== todayStr && b.high > 0 && b.low > 0 && b.close > 0);
    if (pastDailies.length === 0) return null;
    // fetchKisRecentDailyBars는 이미 오름차순(과거→최근)으로 정렬해서 반환하므로 마지막 원소가 직전
    // 확정 거래일이다.
    const targetDaily = pastDailies[pastDailies.length - 1];
    const refHigh = targetDaily.high;
    const refLow = targetDaily.low;
    const refClose = targetDaily.close;

    const P = roundToKrxTick((refHigh + refLow + refClose) / 3);
    const R1 = roundToKrxTick(2 * P - refLow);
    const R2 = roundToKrxTick(P + (refHigh - refLow));

    const levels: PivotLevels = { r1: R1, r2: R2 };
    pivotLevelsCache.set(symbol, { dateStr: todayStr, levels });
    return levels;
  } catch (e: any) {
    console.warn(`[피봇 레벨 조회 실패] ${symbol}: ${e?.message || e}`);
    return null;
  }
}

interface PivotLevelState {
  hasBroken: boolean; // 오늘 이 선을 한 번이라도 뚫은 적 있음(영구 보존)
  hasBeenBelowAfterBreak: boolean; // 뚫은 "이후에" 다시 이 선 아래로 내려간 적 있음(영구 보존, 깊이 무관)
  wasAbove: boolean | null;
  breakoutTs: number | null; // VWAP과 동일(수칙 1-6) - 실시간으로 직접 관측한 재돌파 시각, 30/60초
  // 카운트다운의 기준점. 감시 시작 전 이미 돌파해 있었거나 선 아래로 내려가면 null.
  wasApproaching: boolean; // VWAP과 동일(수칙 1-6) - reclaim_signal_events rising edge 기록용
  wasSellPressure: boolean;
  pendingApproachEventId: number | null; // VWAP과 동일(수칙 1-6) - outcome UPDATE 대상 id
  // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?"] VWAP의 crossCount와 동일한
  // 개념(수칙 1-6) - 감시 시작 후 below→above 전환 누적 횟수. 진짜 전환일 때만 증가.
  crossCount: number;
}

interface PivotWatchState {
  dateStr: string; // 🚨 [버그 수정 - 코드 리뷰 발견: 자정을 넘겨도 상태가 안 지워짐] VwapWatchState와
  // 동일한 이유(위 5899번 줄 주석 참고, 수칙 1-6) - 이게 없으면 어제자 hasBroken/hasBeenBelowAfterBreak가
  // 오늘 판정에 그대로 섞여 들어간다.
  samples: PivotSample[];
  r1: PivotLevelState;
  r2: PivotLevelState;
}

const pivotWatchHistory = getGlobalMap<string, PivotWatchState>('pivotWatchHistory');

// R1/R2 공통 판정 로직 - 중복 방지를 위해 기준선(target) 하나를 매개변수로 받는 함수로 분리(수칙 1-6).
// 🎯 [기능 추가 - 사용자 요청: "남겨두자. 그리고 그걸 순위 밑으로두자"] 예전엔 hasBroken·
// hasBeenBelowAfterBreak가 아직 안 갖춰지면 무조건 전부 false로 뭉개서, "오늘 한 번도 안 뚫음"과
// "뚫었다가 지금 다시 아래로 내려감"을 구분할 방법이 없었다. hadPriorBreak를 별도로 노출해서 화면단이
// "지금 당장 액션 가능(approaching/reclaimed)" vs "이전 이력만 있음(hadPriorBreak)"을 구분해 정렬할 수
// 있게 한다 - VWAP의 hadPriorReclaim과 동일한 목적(수칙 1-6, 대칭 설계).
// 🚨 [버그 수정 - 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"] 예전엔 reclaimed 자체가
// hadPriorBreak(뚫었다 눌렸다 다시 뚫음) 게이트 뒤에 있어서, "처음 뚫은 뒤 한 번도 안 내려가고 계속
// 위(단순 돌파 유지)"인 경우는 reclaimed도 hadPriorBreak도 둘 다 false로 떨어져 아무 배지도 못 받았다
// - 그래서 화면(level 선택 로직)이 R2는 아예 못 본 셈 치고 더 낮은 R1(예전에 진짜 재돌파했던 이력)을
// 대신 보여줬다. hasBroken(뚫은 적 있음)만으로도 신호를 노출하되, "눌렸다 다시 뚫음(재돌파)"과 "처음
// 뚫고 계속 유지(holding)"를 holding 필드로 구분해서 어느 쪽인지는 여전히 알 수 있게 한다.
// 🚨 [버그 수정 - 사용자 지적: "실시간 감시에서 왜 급등주 순매수 조건에 부합하는 종목 데이터가
// 없습니다 라고 뜨는지, r1,r2 유지만 되어도 떠야하는거아 아냐?"] 예전엔 samples.length < 2(=이 서버
// 인스턴스에서 아직 실시간 표본을 2개 못 모음)면 hasBroken이 true(Supabase에서 복구됐어도)여도
// 무조건 전부 false로 뭉갰다 - Vercel 서버리스는 재배포·콜드스타트마다 이 메모리(pivotWatchHistory)가
// 통째로 날아가는데, 그 직후 첫 폴링(최소 15초) 동안은 R1/R2를 실제로 계속 유지 중인 종목까지 전부
// "신호 없음"으로 보여 화면이 통째로 비었다(실측: 프로덕션에서 배포 직후 재현). approach/freshness
// 계산 함수들(computeApproachingSignal, computeReclaimFreshness)은 표본 1개만 있어도 안전하게
// 동작하도록 이미 짜여 있으므로(길이 부족분은 함수 내부에서 자체적으로 안전 처리), currentlyAbove
// 판정에 필요한 표본 1개(방금 push한 현재가)만 있으면 그대로 진행한다.
function computePivotLevelSignal(samples: PivotSample[], levelState: PivotLevelState, target: number, symbol: string, levelType: 'r1' | 'r2'): PivotLevelSignal {
  const hadPriorBreak = levelState.hasBroken && levelState.hasBeenBelowAfterBreak;
  if (samples.length < 1 || !levelState.hasBroken) {
    return { reclaimed: false, holding: false, elapsedMs: null, approaching: false, sellPressureWarning: false, volSurge: false, hadPriorBreak, crossCount: levelState.crossCount };
  }

  const isAbove = (s: PivotSample) => s.price > target;
  const latest = samples[samples.length - 1];
  const currentlyAbove = isAbove(latest);
  const reclaimed = currentlyAbove && hadPriorBreak; // 재돌파(눌렸다 다시 뚫음) - 기존과 동일한 정의, 회귀 없음
  const holding = currentlyAbove && !hadPriorBreak; // 처음 뚫은 뒤 한 번도 안 내려가고 계속 유지 중(신규)

  // VWAP과 완전히 동일한 판정 로직을 재사용한다(수칙 1-6) - target이 VWAP처럼 표본마다 변하지 않고
  // R1/R2로 하루 종일 고정이라는 차이만 있을 뿐, 신선도·거래량 baseline 비교는 동일하다. holding
  // 상태에서도 breakoutTs는 이미 채워져 있으므로(첫 돌파 순간에 설정) elapsedMs가 정상적으로 나온다.
  const freshness = computeReclaimFreshness(samples, levelState.breakoutTs, currentlyAbove);

  const approach = computeApproachingSignal(
    samples.map((s) => ({ ts: s.ts, price: s.price, cumVol: s.cumVol, target }))
  );

  // VWAP과 동일(수칙 1-6) - rising edge에만 기록, falling edge에 outcome(success/failed) 채움.
  if (approach.approaching && !levelState.wasApproaching) {
    logReclaimSignalEvent({ date: getKstTodayStr(), symbol, levelType, eventType: 'approaching', price: latest.price, target, buyVolume: approach.buyVolume, sellVolume: approach.sellVolume, recentRate: approach.recentRate, baselineRate: approach.baselineRate, todayAvgRate: approach.todayAvgRate })
      .then((id) => { levelState.pendingApproachEventId = id; })
      .catch(() => {});
  } else if (approach.sellPressureWarning && !levelState.wasSellPressure) {
    logReclaimSignalEvent({ date: getKstTodayStr(), symbol, levelType, eventType: 'sell_pressure', price: latest.price, target, buyVolume: approach.buyVolume, sellVolume: approach.sellVolume, recentRate: approach.recentRate, baselineRate: approach.baselineRate, todayAvgRate: approach.todayAvgRate }).catch(() => {});
  } else if (!approach.approaching && levelState.wasApproaching && levelState.pendingApproachEventId !== null) {
    updateReclaimSignalOutcome(levelState.pendingApproachEventId, currentlyAbove ? 'success' : 'failed').catch(() => {});
    levelState.pendingApproachEventId = null;
  }
  levelState.wasApproaching = approach.approaching;
  levelState.wasSellPressure = approach.sellPressureWarning;

  return {
    reclaimed,
    holding,
    elapsedMs: freshness.elapsedMs,
    approaching: approach.approaching,
    sellPressureWarning: approach.sellPressureWarning,
    volSurge: freshness.volSurge,
    hadPriorBreak,
    crossCount: levelState.crossCount,
  };
}

// 🚨 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] live/levels를 파라미터로 받는 내부 함수로
// 분리했다 - computeVwapSignalFromLive와 동일한 이유(위 5906번 줄 주석 참고). 이제 live는
// computeReclaimWatchSignal(아래)이 한 번만 조회해서 VWAP·피봇 양쪽에 함께 넘긴다.
async function computePivotSignalFromLive(
  symbol: string,
  live: { price: number; cumVol: number; cumVal: number } | null,
  levels: PivotLevels | null
): Promise<PivotReclaimSignal> {
  const emptyLevel: PivotLevelSignal = { reclaimed: false, holding: false, elapsedMs: null, approaching: false, sellPressureWarning: false, volSurge: false, hadPriorBreak: false, crossCount: 0 };
  const fallback: PivotReclaimSignal = { symbol, r1: emptyLevel, r2: emptyLevel, insufficientData: true, priceLeg: null };
  if (!live || !levels) return fallback;

  const todayStr = getKstTodayStr();
  let state = pivotWatchHistory.get(symbol);
  if (!state || state.dateStr !== todayStr) {
    // 🚨 [버그 수정 - 사용자 지적: "저걸 어떻게 고치지" (재시작/서버리스 콜드스타트에 플래그 유실)]
    // VWAP 감시와 동일한 이유(수칙 1-6) - 이 프로세스에서 이 심볼을 처음 감시하는 시점이거나 날짜가
    // 바뀐 시점(코드 리뷰에서 발견된 자정 경계 미처리 버그 수정)이면 오늘자로 이미 Supabase에 저장된
    // R1/R2 돌파 플래그가 있는지 먼저 확인해서 복구한다. breakoutTs는 VWAP과 동일한 이유로 영구
    // 저장하지 않는다 - 유실되면 "타이밍 모름"으로 처리되고 다음 실시간 전환부터 다시 정확히 잰다.
    const persisted = await fetchWatchSignalState(todayStr, symbol);
    state = {
      dateStr: todayStr,
      samples: [],
      r1: { hasBroken: persisted?.pivotR1HasBroken ?? false, hasBeenBelowAfterBreak: persisted?.pivotR1HasBeenBelowAfterBreak ?? false, wasAbove: null, breakoutTs: null, wasApproaching: false, wasSellPressure: false, pendingApproachEventId: null, crossCount: persisted?.pivotR1CrossCount ?? 0 },
      r2: { hasBroken: persisted?.pivotR2HasBroken ?? false, hasBeenBelowAfterBreak: persisted?.pivotR2HasBeenBelowAfterBreak ?? false, wasAbove: null, breakoutTs: null, wasApproaching: false, wasSellPressure: false, pendingApproachEventId: null, crossCount: persisted?.pivotR2CrossCount ?? 0 },
    };
  }

  const lastStoredSample = state.samples[state.samples.length - 1];
  if (!lastStoredSample || live.cumVol > lastStoredSample.cumVol) {
    const prevR1Broken = state.r1.hasBroken;
    const prevR1Below = state.r1.hasBeenBelowAfterBreak;
    const prevR1Cross = state.r1.crossCount;
    const prevR2Broken = state.r2.hasBroken;
    const prevR2Below = state.r2.hasBeenBelowAfterBreak;
    const prevR2Cross = state.r2.crossCount;
    const updateLevelState = (levelState: PivotLevelState, target: number) => {
      const isAboveNow = live.price > target;
      // VWAP과 동일한 버그 수정(수칙 1-6, 위 6749번째 줄 근처 주석 참고) - wasAbove가 null(이 프로세스
      // 에서 처음 관측하는데 이미 위인 경우)이어도 breakoutTs를 지금 시각으로 잡아 "확인불가"에 갇히지
      // 않게 한다. hasBroken은 원래대로 무조건 갱신.
      const isFreshAboveObservation = (levelState.wasAbove === false || levelState.wasAbove === null) && isAboveNow;
      // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?"] VWAP과 동일(수칙 1-6) -
      // "진짜 전환"(직전 관측이 확실히 아래였다가 지금 위로)일 때만 증가시킨다. wasAbove===null(이
      // 프로세스에서 처음 관측)인 경우는 전환이 아니라 "원래 위였는지 모름"이라 세지 않는다.
      if (levelState.wasAbove === false && isAboveNow) levelState.crossCount++;
      if (isAboveNow) {
        levelState.hasBroken = true;
        if (isFreshAboveObservation) levelState.breakoutTs = Date.now(); // 실시간으로 직접 관측한 재돌파 순간
      }
      if (levelState.hasBroken && !isAboveNow) levelState.hasBeenBelowAfterBreak = true;
      if (!isAboveNow) levelState.breakoutTs = null; // VWAP과 동일(사용자 확정): 내려가면 즉시 리셋
      levelState.wasAbove = isAboveNow;
    };
    updateLevelState(state.r1, levels.r1);
    updateLevelState(state.r2, levels.r2);

    state.samples.push({ ts: Date.now(), price: live.price, cumVol: live.cumVol });
    // 🚨 [버그 수정 - 사용자 지적: "박스구간 5분 장난해?"] VWAP_WATCH_MAX_SAMPLES(5분)로 캡핑하면
    // firstBrokenTs 기반 박스 관찰 구간이 아무리 늘어나려 해도 원본 표본 자체가 5분치밖에 안 남아있어
    // 무의미했다 - 피봇 전용 상한(PIVOT_WATCH_MAX_SAMPLES, 위 6539번째 줄 근처)을 쓴다.
    if (state.samples.length > PIVOT_WATCH_MAX_SAMPLES) state.samples.shift();
    pivotWatchHistory.set(symbol, state);

    // VWAP 감시와 동일하게, 플래그가 실제로 바뀐 순간에만 영구 저장(fire-and-forget).
    if (
      state.r1.hasBroken !== prevR1Broken || state.r1.hasBeenBelowAfterBreak !== prevR1Below || state.r1.crossCount !== prevR1Cross ||
      state.r2.hasBroken !== prevR2Broken || state.r2.hasBeenBelowAfterBreak !== prevR2Below || state.r2.crossCount !== prevR2Cross
    ) {
      upsertWatchSignalState(todayStr, symbol, {
        pivotR1HasBroken: state.r1.hasBroken,
        pivotR1HasBeenBelowAfterBreak: state.r1.hasBeenBelowAfterBreak,
        pivotR2HasBroken: state.r2.hasBroken,
        pivotR2HasBeenBelowAfterBreak: state.r2.hasBeenBelowAfterBreak,
        pivotR1CrossCount: state.r1.crossCount,
        pivotR2CrossCount: state.r2.crossCount,
      }).catch(() => {});
    }
  }

  // 🚨 [버그 수정 - 위 computePivotLevelSignal 주석과 동일 원인(수칙 1-6)] 여기서 samples.length < 2로
  // 막아버리면 방금 push한 현재가 표본(samples.length === 1)이 있어도 computePivotLevelSignal 자체를
  // 호출하지 못해 hasBroken 복구 여부와 무관하게 무조건 fallback(전부 false)이 나갔다. 표본이 정말
  // 0개(현재가 조회 자체 실패 등 - live가 null이면 위에서 이미 fallback으로 빠짐)일 때만 막는다.
  if (state.samples.length < 1) return { ...fallback, insufficientData: true };

  // 🎯 [기능 추가 - 사용자 요청: "박스권 하락, 박스권 돌파 이런걸 원했던건데... 순위표 배지로"] R1/R2와
  // 무관하게, 이 종목의 실시간 표본 전체를 박스/상승/하락 구간으로 나누고 그중 "가장 최근" 구간(=지금
  // 상태)만 순위표 배지용으로 뽑는다.
  const legs = detectPriceLegsFromSamples(state.samples);
  const lastLeg = legs.length > 0 ? legs[legs.length - 1] : null;
  // 🚨 [버그 수정 - 실측: dev 서버 재시작 직후 모든 종목이 표본 1개(0%)인데도 전부 "박스권재돌파(+0%)"로
  // 동일하게 뜸] pushTrendLeg는 표본이 1개(start===end)여도 "종료가 >= 시작가"가 항상 참(같은 값)이라
  // 무조건 'up'으로 확정해버렸다 - 방금 감시를 시작해서 아직 표본이 거의 없는 상태를 "상승 중"이라고
  // 확신하는 건 명백한 오판이다. 박스는 이미 PRICE_LEG_MIN_SAMPLES(15분)를 넘어야만 만들어지지만,
  // 추세(상승/하락) leg에는 최소 표본 수 제한이 없었던 게 근본 원인 - 최소 3개(약 30~45초, 기존
  // BOX_MIN_SAMPLES와 동일한 근거)는 넘어야 방향을 확정한다.
  const PRICE_LEG_MIN_TREND_SAMPLES = 3;
  const currentLeg = lastLeg && (lastLeg.type === 'box' || lastLeg.endIdx - lastLeg.startIdx + 1 >= PRICE_LEG_MIN_TREND_SAMPLES) ? lastLeg : null;
  const priceLeg: PriceLegSignal | null = currentLeg ? (() => {
    const startSample = state!.samples[currentLeg.startIdx];
    const endSample = state!.samples[currentLeg.endIdx];
    const mid = (currentLeg.high + currentLeg.low) / 2;
    const changePct = currentLeg.type === 'box'
      ? (mid > 0 ? Number((((currentLeg.high - currentLeg.low) / mid) * 100).toFixed(2)) : 0)
      : (startSample.price > 0 ? Number((((endSample.price - startSample.price) / startSample.price) * 100).toFixed(2)) : 0);
    return {
      type: currentLeg.type,
      high: currentLeg.high,
      low: currentLeg.low,
      changePct,
      startTs: startSample.ts,
      durationMs: endSample.ts - startSample.ts,
    };
  })() : null;

  return {
    symbol,
    r1: computePivotLevelSignal(state.samples, state.r1, levels.r1, symbol, 'r1'),
    r2: computePivotLevelSignal(state.samples, state.r2, levels.r2, symbol, 'r2'),
    insufficientData: false,
    priceLeg,
  };
}

export interface ReclaimWatchSignal {
  symbol: string;
  vwap: VwapReclaimSignal;
  pivot: PivotReclaimSignal;
}

// 🎯 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] VWAP 감시와 피봇 감시를 하나의 조회로 합친다 -
// 두 기능은 어차피 항상 같은 종목 리스트·같은 15초 주기로 함께 쓰이는데, 지금까지는 서로 다른 API
// 라우트(별개 서버리스 함수)가 각자 fetchKisLiveVwapSample을 호출해 같은 종목의 현재가를 중복으로
// 물어보고 있었다. 5초 dedupe 캐시로 고쳐보려 했지만 프로덕션에서는 두 함수가 메모리를 공유하지 않아
// 무용지물이었다(위 5906번 줄 주석) - 근본 해결은 "애초에 하나의 함수 실행 안에서 한 번만 조회해서
// 같이 쓰는 것"이다. live/levels 조회를 한 번만 하고 VWAP·피봇 계산 둘 다에 넘긴다.
export async function computeReclaimWatchSignal(symbol: string): Promise<ReclaimWatchSignal> {
  const [live, levels] = await Promise.all([fetchKisLiveVwapSample(symbol), getPivotLevelsForSymbol(symbol)]);
  const [vwap, pivot] = await Promise.all([
    computeVwapSignalFromLive(symbol, live),
    computePivotSignalFromLive(symbol, live, levels),
  ]);
  return { symbol, vwap, pivot };
}

export async function pollReclaimWatchBatch(symbols: string[]): Promise<ReclaimWatchSignal[]> {
  const uniqueSymbols = Array.from(new Set(symbols)).slice(0, 60);
  return runInChunks(uniqueSymbols, 30, (s) => computeReclaimWatchSignal(s));
}

// ============================================================================
// 🏷️ [신규 독립 모듈] 종목 검색 옆 "전 탭 뱃지 모음" - 현재 이 종목이 급등주/단타종합랭킹/외국인/기관/
// 프로그램/수급교집합(당일·2일연속·3일연속) 중 어느 탭에 떠 있는지 한눈에 모아 보여준다.
//
// 🚨 [버그 수정] 원래는 새 KIS 라이브 호출 없이 각 탭이 이미 채워둔 인메모리 캐시(surgingCacheStore,
// rankingCacheStore, comprehensiveCacheStore, overlapMemoryCache 등)를 "훑어보기"만 하는 설계였다.
// 그런데 Vercel 프로덕션에서 실측한 결과 이게 거의 항상 비어있는 결과만 반환했다 - Vercel은 API
// 라우트마다 별도 서버리스 컨테이너(별도 프로세스)로 뜨는 경우가 있어서, 방금 /api/stock/ranking을
// 호출해 rankingCacheStore를 채워도 바로 이어진 /api/stock/badges 요청은 완전히 다른 컨테이너라 그
// 메모리를 전혀 못 보기 때문이다(실측: 삼성중공업 외국인 순매수 1위 조회 직후 뱃지 조회가 badges:[]).
// 그래서 아래 1~5번(급등주/단타종합/외국인·기관/프로그램/당일교집합)은 캐시를 "훑어보기"만 하는 대신
// 각 탭이 쓰는 것과 동일한 함수를 직접 호출한다 - 이 함수들은 전부 자체 TTL 캐시를 갖고 있어서(콜드일
// 때만 실제로 라이브 조회) 이 컨테이너 자신의 캐시를 그 자리에서 채우게 되고, 종목별 반복 조회가 없는
// "요약형" 조회라 비용도 작다(실측: 외국인 랭킹 콜드 조회 ~900ms, 당일교집합 ~270ms 수준).
//
// 단 6번(2일/3일연속 교집합, fetchConsecutiveNDaysOverlapRankingData)만은 예외로 기존처럼 캐시를
// "있으면 쓰고 없으면 그냥 건너뛴다" - 콜드 상태에서 후보 종목마다 라이브 조회가 최대 15~95건까지
// 발생할 수 있어(실측 최대 108초, CONSECUTIVE_OVERLAP_CACHE_TTL_MS 참고) 여기서 직접 호출하면
// 힘들게 고친 kisQueue congestion(로컬 무한로딩 버그)을 뱃지 조회 하나로 재현하게 되기 때문이다.
// pushIfFound가 실제로 쓰는 필드만 뽑은 최소 타입 - Supabase shared_rank_cache에서 온 트림된 행과
// 라이브 함수가 돌려주는 완전한 RankingItem 양쪽 다 이 타입을 만족하므로 소스를 가리지 않고 재사용한다.
type BadgeSourceItem = Pick<
  RankingItem,
  'symbol' | 'rank' | 'netBuyAmt' | 'statusBadge' | 'statusBadgeStyle' | 'surgingBadge' | 'investorBadge' | 'netBuyAmtEok' | 'scoreBreakdown' | 'aiPickRank' | 'ranksByType' | 'asOfDateLabel'
>;

export async function getStockBadgeSummary(symbol: string, market: MarketType = 'ALL'): Promise<StockBadgeItem[]> {
  const badges: StockBadgeItem[] = [];

  const findIn = (list: BadgeSourceItem[] | undefined): { item: BadgeSourceItem; rank: number } | null => {
    if (!Array.isArray(list)) return null;
    const idx = list.findIndex((r) => r.symbol === symbol);
    if (idx === -1) return null;
    return { item: list[idx], rank: list[idx].rank || idx + 1 };
  };

  // expectedDirection이 있으면 item.netBuyAmt 부호가 그 방향과 실제로 일치할 때만 채택한다 - 프로그램
  // 순매도 캐시에서 실제로는 순매수(양수)인 종목이 순위표 하위에 그대로 끼어 있던 게 실측으로 확인돼서
  // (getBatchRankingData가 방향별로 완전히 분리 정렬하지 않는 경우가 있음) 방어적으로 걸러낸다.
  const pushIfFound = (tabId: string, tabLabel: string, list: BadgeSourceItem[] | undefined, expectedDirection?: RankingDirection) => {
    const found = findIn(list);
    if (!found) return;
    const { item, rank } = found;
    if (expectedDirection) {
      const amt = item.netBuyAmt || 0;
      const matches = expectedDirection === 'buy' ? amt > 0 : amt < 0;
      if (!matches) return;
    }
    badges.push({
      tabId,
      tabLabel,
      rank,
      statusBadge: item.statusBadge,
      statusBadgeStyle: item.statusBadgeStyle,
      surgingBadge: item.surgingBadge,
      investorBadge: item.investorBadge,
      netBuyAmtEok: item.netBuyAmtEok,
      scoreTotal: item.scoreBreakdown?.totalScore,
      aiPickRank: item.aiPickRank,
      ranksByType: item.ranksByType,
      // 🚨 [기능 추가 - 사용자 요청] 이 탭의 배지가 몇 시 기준 스냅샷인지 그대로 실어보낸다 -
      // 없는 탭(급등주/단타종합 등 asOfDateLabel을 안 채우는 타입)은 undefined로 남겨 프론트가
      // "시각 정보 없음"으로 자연스럽게 처리하게 한다.
      asOfDateLabel: item.asOfDateLabel,
    });
  };

  // 카테고리별 cache_key를 먼저 계산해둔다 - 아래 Supabase 일괄조회와 각 in-memory Map의 실제 .set()
  // 호출부(syncSharedRankCache 호출 지점들)가 쓰는 키 형식과 반드시 정확히 일치해야 한다.
  const K = {
    surgingFluctuation: `surging-fluctuation-${market}`,
    surgingVolume: `surging-volume-${market}`,
    surgingAmount: `surging-amount-${market}`,
    comprehensive: `comprehensive-${market}`,
    foreignBuy: `foreign-inst-foreign-buy-1d-${market}-50`,
    foreignSell: `foreign-inst-foreign-sell-1d-${market}-50`,
    organBuy: `foreign-inst-organ-buy-1d-${market}-50`,
    organSell: `foreign-inst-organ-sell-1d-${market}-50`,
    overlapDailyBuy: `v3_master_buy_1d_2_${market}`,
    overlapDailySell: `v3_master_sell_1d_2_${market}`,
    programBuy: `program_buy_1d`,
    programSell: `program_sell_1d`,
    overlap2dBuy: `c_buy_2d_2_${market}_50`,
    overlap2dSell: `c_sell_2d_2_${market}_50`,
    overlap3dBuy: `c_buy_3d_2_${market}_50`,
    overlap3dSell: `c_sell_3d_2_${market}_50`,
    // 🚨 [기능 추가 - 사용자 요청: "오늘 만든 장마감 후보군도 뱃지모음에 나오게 해줘"] 각 함수가
    // syncSharedRankCache(cacheKey, ...)를 저장할 때 쓰는 cacheKey와 정확히 동일한 문자열이어야 한다.
    postmarket: `postmarket-${market}`,
  } as const;

  // 🚨 [Supabase 공유 캐시 우선 조회] 이 컨테이너 자신의 인메모리 캐시가 비어 있어도, 다른 컨테이너가
  // 최근(5분 이내)에 계산해서 Supabase에 반영해둔 게 있으면 라이브 호출 없이 바로 가져다 쓴다. 여러
  // 서버리스 컨테이너가 각자 계산해온 결과가 결국 이 한 테이블로 모이므로, 트래픽이 조금이라도 있는
  // 프로덕션에서는 대부분 아래 "라이브 직접 호출" 단계 자체가 필요 없어진다.
  const shared = await fetchSharedRankCacheBatch(Object.values(K)).catch(() => new Map<string, BadgeSourceItem[]>());

  // 1~3, 5번(급등주 3종/단타종합/외국인·기관/당일교집합, 총 10개)은 Supabase에 없는 것만 라이브로 채운다.
  //
  // 🚨 [버그 수정] 처음엔 10개를 무조건 Promise.all로 다 기다렸는데, 프로덕션 실측(진짜 콜드 컨테이너 +
  // 다른 요청과 같은 kisQueue를 공유하는 실제 트래픽 상황)에서 30초를 넘겨 FUNCTION_INVOCATION_TIMEOUT으로
  // 배지 라우트 전체가 죽는 게 확인됐다. Promise.all은 "전부 끝나야 응답"이라 느린 것 하나가 전체를 막는
  // 구조라, 대신 전체에 시간 예산을 두고 그 안에 끝난 것만 쓴다 - 늦게 끝난 건 이번 응답엔 못 넣지만
  // 각자의 캐시(및 Supabase)는 계속 채워지므로 다음 요청부턴 더 빨라진다.
  const LIVE_SOURCES: Array<{ key: string; fetcher: () => Promise<InvestorRankingResponse> }> = [
    { key: K.surgingFluctuation, fetcher: () => fetchKisSurgingStocks('fluctuation', market) },
    { key: K.surgingVolume, fetcher: () => fetchKisSurgingStocks('volume', market) },
    { key: K.surgingAmount, fetcher: () => fetchKisSurgingStocks('amount', market) },
    { key: K.comprehensive, fetcher: () => fetchKisComprehensiveScoreRanking(market) },
    { key: K.foreignBuy, fetcher: () => fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', market, 50) },
    { key: K.foreignSell, fetcher: () => fetchKisForeignInstitutionRanking('foreign', 'sell', '1d', market, 50) },
    { key: K.organBuy, fetcher: () => fetchKisForeignInstitutionRanking('organ', 'buy', '1d', market, 50) },
    { key: K.organSell, fetcher: () => fetchKisForeignInstitutionRanking('organ', 'sell', '1d', market, 50) },
    { key: K.overlapDailyBuy, fetcher: () => fetchOverlapRankingData('buy', '1d', 2, 50, market) },
    { key: K.overlapDailySell, fetcher: () => fetchOverlapRankingData('sell', '1d', 2, 50, market) },
  ];
  const missing = LIVE_SOURCES.filter((s) => !shared.has(s.key));
  const liveResults = new Map<string, BadgeSourceItem[] | undefined>();
  if (missing.length > 0) {
    const BADGE_SOURCE_TIME_BUDGET_MS = 18000; // 라우트 maxDuration(30초)보다 충분히 여유있게
    const slots = missing.map(() => ({ value: undefined as BadgeSourceItem[] | undefined }));
    const allFilled = Promise.all(
      missing.map((s, i) =>
        s
          .fetcher()
          .then((res) => {
            slots[i].value = res?.list;
          })
          .catch(() => {
            slots[i].value = undefined;
          })
      )
    );
    await Promise.race([allFilled, new Promise((resolve) => setTimeout(resolve, BADGE_SOURCE_TIME_BUDGET_MS))]);
    missing.forEach((s, i) => liveResults.set(s.key, slots[i].value));
  }
  const resolve = (key: string): BadgeSourceItem[] | undefined => shared.get(key) || liveResults.get(key);

  // 1. 급등주 3종 서브모드
  pushIfFound('surging-fluctuation', '급등주(등락률)', resolve(K.surgingFluctuation));
  pushIfFound('surging-volume', '급등주(거래량)', resolve(K.surgingVolume));
  pushIfFound('surging-amount', '급등주(거래대금)', resolve(K.surgingAmount));

  // 2. 단타 종합랭킹
  pushIfFound('comprehensive', '단타 종합랭킹', resolve(K.comprehensive));

  // 3. 외국인/기관 순매수·순매도
  pushIfFound('foreign-buy', '외국인 순매수', resolve(K.foreignBuy), 'buy');
  pushIfFound('foreign-sell', '외국인 순매도', resolve(K.foreignSell), 'sell');
  pushIfFound('organ-buy', '기관 순매수', resolve(K.organBuy), 'buy');
  pushIfFound('organ-sell', '기관 순매도', resolve(K.organSell), 'sell');

  // 4. 프로그램 순매수·순매도 - Supabase에 있으면 그걸 쓰고, 없는 방향만 기존처럼 getBatchRankingData로
  // 폴백한다(라이브 호출이 아니라 batchCollector 자체 캐시 peek + 백그라운드 예열 트리거일 뿐이라 원래도
  // 안전했음 - 이번에도 그대로 유지, 다만 이제 Supabase 덕에 다른 컨테이너 결과도 볼 수 있게 됨).
  try {
    const sharedProgramBuy = shared.get(K.programBuy);
    const sharedProgramSell = shared.get(K.programSell);
    if (sharedProgramBuy) pushIfFound('program-buy', '프로그램 순매수', sharedProgramBuy, 'buy');
    if (sharedProgramSell) pushIfFound('program-sell', '프로그램 순매도', sharedProgramSell, 'sell');
    if (!sharedProgramBuy || !sharedProgramSell) {
      const { getBatchRankingData } = await import('./batchCollector');
      (['buy', 'sell'] as const).forEach((direction) => {
        if (direction === 'buy' && sharedProgramBuy) return;
        if (direction === 'sell' && sharedProgramSell) return;
        const res = getBatchRankingData('program', direction, '1d', market);
        if (res.list && res.list.length > 0 && res.lastBatchTime !== '배치 수집 중') {
          pushIfFound(`program-${direction}`, `프로그램 ${direction === 'buy' ? '순매수' : '순매도'}`, res.list, direction);
        }
      });
    }
  } catch (_) {}

  // 5. 수급교집합 - 당일
  pushIfFound('overlap-daily-buy', '수급교집합(당일) 순매수', resolve(K.overlapDailyBuy), 'buy');
  pushIfFound('overlap-daily-sell', '수급교집합(당일) 순매도', resolve(K.overlapDailySell), 'sell');

  // 6. 수급교집합 - 2일연속/3일연속. Supabase에 있으면 그걸 쓰고, 없으면 기존처럼 이 컨테이너 인메모리
  // peek만 시도한다(여전히 라이브 호출은 절대 하지 않음 - 콜드 시 최대 108초 걸릴 수 있는 그 경로).
  ([2, 3] as const).forEach((targetDays) => {
    (['buy', 'sell'] as const).forEach((direction) => {
      const key = targetDays === 2 ? (direction === 'buy' ? K.overlap2dBuy : K.overlap2dSell) : (direction === 'buy' ? K.overlap3dBuy : K.overlap3dSell);
      const list = shared.get(key) || (consecutiveOverlapMemoryCache.get(`c_${direction}_${targetDays}d_2_${market}_50`)?.data.list as BadgeSourceItem[] | undefined);
      pushIfFound(`overlap-${targetDays}d-${direction}`, `수급교집합(${targetDays}일연속) ${direction === 'buy' ? '순매수' : '순매도'}`, list, direction);
    });
  });

  // 🚨 [기능 추가 - 사용자 요청: "오늘 만든 장마감 후보군도 뱃지모음에 나오게 해줘"] 장마감 후보군 탭도
  // 종목당 KIS 라이브 호출(fetchKisDailyPrice)이 여러 건 걸리는 무거운 계산이라, 2일/3일연속과 동일
  // 원칙으로 여기서 새로 라이브 계산을 트리거하지 않는다 - Supabase 공유캐시나 이 컨테이너의 인메모리
  // 캐시(postMarketCacheStore)에 이미 있는 것만 본다.
  // 7. 장마감 후보군(급등주 기반) - 항상 순매수 단일 방향(fetchKisPostMarketCandidates에 direction 파라미터 자체가 없음)
  {
    const list = shared.get(K.postmarket) || (postMarketCacheStore.get(`postmarket-${market}`)?.data.list as BadgeSourceItem[] | undefined);
    pushIfFound('postmarket', '급등 장마감', list);
  }

  // 🚨 [기능 재설계 - "토글 필터로 진행해줘"] 예전엔 "수급 장마감 후보군"이 3일연속 전용 4번째 탭이라
  // 별도 배지 항목(8번)이 필요했다. 지금은 당일/2일연속/3일연속 위에 얹는 "장마감 후보만" 토글일 뿐이라,
  // 그 토글로 걸러진 종목도 결국 원래 탭(overlap-daily/overlap-2d/overlap-3d, 아래 6번 근방)의 정식
  // 멤버라 이미 배지가 뜬다 - 별도 항목을 중복으로 만들 필요가 없어졌다(수칙 1-6).
  return badges;
}
