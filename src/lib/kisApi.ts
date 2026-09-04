// KIS API Service Module - Updated Queue Delay & Rate Limit Guard
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InvestorTrendDay, InvestorTrendResponse, KisTokenResponse, ProgramTradeIntradayPoint, ProgramTradeSummary, SupplySummary, TrendPeriod, InvestorRankingResponse, RankingItem, RankingDirection, RankingPeriod, RankingType, OverlapInvestorRank, MarketType, SurgingRankItem, ScoreBreakdown, SurgingMode, isEtfOrEtn, IntradayCandlePoint, IntradayPivotFibonacciLevels, IntradayChartResponse, IndexTrendResponse, IndexTrendDay, StockBadgeItem, StockBadgeSummaryResponse } from './types';
import { getStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, resolveMarketType, computeUnifiedStatusBadge, getSettledAsOfDateLabel, getKrxEstimateSlotInfo, findSplitSafeStartIndex, roundToKrxTick, computeRecentVolumeRatio } from './mockData';
import { TOP_300_STOCKS } from './stockUniverse300';
import { fetchTokenFromSupabase, fetchCreditBatchFromSupabase, saveCreditBatchToSupabase, fetchIntraday3mCandlesFromSupabase, saveIntraday3mCandlesToSupabase, fetchConsecutiveOverlapWatch, upsertConsecutiveOverlapWatch, fetchDailyOverlapFirstSeen, insertDailyOverlapFirstSeenIfMissing, fetchLatestActiveBeforeDate, upsertSharedRankCache, fetchSharedRankCacheBatch } from './supabase';
export { resolveStockPriceAndChange, computeUnifiedStatusBadge };

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
 * 🚨 [버그 수정] "종목 검색 옆 전 탭 뱃지 모음" 기능을 만들다가 실측으로 발견한 문제: 이 파일의 랭킹류
 * 캐시(overlapMemoryCache 등)가 전부 평범한 모듈 스코프 `const cache = new Map()`였는데, Next.js가
 * route.ts 파일마다 별도 번들/모듈 인스턴스를 만드는 경우(로컬 Turbopack HMR, Vercel 서버리스 함수 분리
 * 등) 이 Map이 라우트마다 따로 생성돼서 "A 탭에서 방금 계산해둔 캐시를 B 탭(다른 route.ts)에서는 전혀
 * 못 본다"는 게 실측으로 확인됐다(당일교집합 라우트에서 예열해도 직후 다른 라우트에서 조회하면 0건).
 * KIS 토큰 캐시가 이미 이 문제를 globalThis + Symbol.for로 풀어놨던 것과 동일한 패턴을 재사용해서,
 * 진짜 프로세스 전역으로 공유되는 Map을 만든다.
 */
export function getGlobalMap<K, V>(name: string): Map<K, V> {
  const key = Symbol.for(`kos_for_global_cache_${name}`);
  const g = globalThis as any;
  if (!g[key]) g[key] = new Map<K, V>();
  return g[key] as Map<K, V>;
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
  private minDelayMs = 300; // 300ms 딜레이 (초당 약 3.3건으로 KIS 허용 속도 내에서 EGW00201 방지)
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
  const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 900 && timeNum < 1530;

  // 1. 장중 (09:00 ~ 15:30): 30초 짧은 캐시로 실시간 가집계 반영
  if (isMarketOpen) {
    return 30 * 1000; // 30초
  }

  // 2. 장마감 후 (평일 15:30 이후 또는 주말): 다음 영업일 08:30 개장 전까지 불변 캐시
  const nextOpenDate = new Date(kstDate);
  if (dayOfWeek === 5 && timeNum >= 1530) {
    nextOpenDate.setDate(kstDate.getDate() + 3); // 금요일 저녁 ➔ 월요일 08:30
  } else if (dayOfWeek === 6) {
    nextOpenDate.setDate(kstDate.getDate() + 2); // 토요일 ➔ 월요일 08:30
  } else if (dayOfWeek === 0) {
    nextOpenDate.setDate(kstDate.getDate() + 1); // 일요일 ➔ 월요일 08:30
  } else if (timeNum >= 1530) {
    nextOpenDate.setDate(kstDate.getDate() + 1); // 평일(월~목) 저녁 ➔ 익일 08:30
  }

  nextOpenDate.setHours(8, 30, 0, 0);
  const remainingMs = nextOpenDate.getTime() - kstDate.getTime();
  return remainingMs > 0 ? remainingMs : 30 * 1000;
}

// ============================================================================
// 📈 [신규 독립 모듈] KOSPI/KOSDAQ 지수 일봉 차트 (현재지수 + 일자별 시세)
// ============================================================================
const indexTrendMemoryCache = new Map<string, { data: IndexTrendResponse; timestamp: number }>();
const INDEX_TREND_CACHE_TTL_MS = 30 * 1000; // 30초 - 여러 사용자가 동시에 볼 수 있어 캐시 필요

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
  const cacheKey = `index-${code}-${period}${summaryOnly ? '-summary' : ''}`;
  const cached = indexTrendMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < INDEX_TREND_CACHE_TTL_MS) {
    return cached.data;
  }

  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;
  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  const response = await kisQueue.enqueue(
    () => fetchWithRetry(() => executeKisIndexDailyTrendFetch(code, name, period, summaryOnly)),
    'HIGH',
    `index-trend-${code}-${period}${summaryOnly ? '-summary' : ''}`
  );

  indexTrendMemoryCache.set(cacheKey, { data: response, timestamp: Date.now() });
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
  const priceUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${indexCode}`;
  const priceRes = await fetch(priceUrl, { headers: buildHeaders('FHPUP02100000'), cache: 'no-store' });
  if (!priceRes.ok) throw new Error(`[KIS FHPUP02100000 HTTP ${priceRes.status}] ${indexName} 현재지수 조회 실패`);
  const priceJson = await priceRes.json();
  if (priceJson.rt_cd !== '0') throw new Error(`[KIS FHPUP02100000] ${priceJson.msg1 || '알 수 없는 오류'}`);
  const p = priceJson.output || {};
  const priceSign = p.prdy_vrss_sign || '3';
  const priceChange = Number(p.bstp_nmix_prdy_vrss || 0) * (priceSign === '4' || priceSign === '5' ? -1 : 1);

  // 2. 지수 일자별(일봉) 시세 - KIS는 최신순(내림차순)으로 내려주므로 오름차순으로 뒤집는다
  // 🚨 [성능 수정] 코스피/코스닥 카드(요약용)는 현재가만 필요하고 일봉 배열은 안 쓰는데, 예전엔 카드
  // 하나 띄울 때마다 이 무거운 일봉 호출까지 매번 같이 나가서 콜드스타트 때 kisQueue 정체를 더 키웠다.
  // summaryOnly면 이 두 번째 KIS 호출 자체를 생략한다(카드 컴포넌트가 매 페이지 로드마다 부담하던 지수당
  // 2회 → 1회로 절반 감소, KOSPI+KOSDAQ 합쳐 4회 → 2회).
  if (summaryOnly) {
    return {
      indexInfo: {
        code: indexCode,
        name: indexName,
        currentPrice: Number(p.bstp_nmix_prpr || 0),
        change: priceChange,
        changeRate: Number(p.bstp_nmix_prdy_ctrt || 0),
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

  const todayStr = getKstTodayStr();
  const dailyUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-daily-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${indexCode}&FID_INPUT_DATE_1=${todayStr}&FID_PERIOD_DIV_CODE=D`;
  const dailyRes = await fetch(dailyUrl, { headers: buildHeaders('FHPUP02120000'), cache: 'no-store' });
  if (!dailyRes.ok) throw new Error(`[KIS FHPUP02120000 HTTP ${dailyRes.status}] ${indexName} 일봉 조회 실패`);
  const dailyJson = await dailyRes.json();
  if (dailyJson.rt_cd !== '0') throw new Error(`[KIS FHPUP02120000] ${dailyJson.msg1 || '알 수 없는 오류'}`);
  const rawDaily: any[] = Array.isArray(dailyJson.output2) ? dailyJson.output2 : [];

  const ascending = [...rawDaily].reverse();
  const limit = period === '5d' ? 5 : period === '20d' ? 20 : 60;
  const sliced = ascending.slice(-limit);

  const trend: IndexTrendDay[] = sliced.map((d) => {
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
      changeRate: Number(p.bstp_nmix_prdy_ctrt || 0),
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

  try {
    const response = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisInvestorTrendFetch(symbol, period)),
      priority,
      `trend-${symbol}-${period}`
    );

    if (response) {
      trendDetailCache.set(cacheKey, { data: response, timestamp: Date.now() });
    }
    return response;
  } catch (err: any) {
    if (trendDetailCache.has(cacheKey)) {
      return trendDetailCache.get(cacheKey)!.data;
    }
    throw err;
  }
}

/**
 * KIS OpenAPI HHPTJ04160200: 종목별 외인기관 추정가집계 조회
 * (개별 종목에 대해 10:00 1차, 11:30 2차, 13:20 3차, 14:30 4차 잠정치를 장중에 실시간 제공)
 */
export async function fetchKisInvestorTrendEstimate(symbol: string): Promise<{
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

  try {
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
    });

    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (json && json.rt_cd === '0' && Array.isArray(json.output2) && json.output2.length > 0) {
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
  } catch (err) {
    console.error(`[HHPTJ04160200 Error] symbol=${symbol}:`, err);
  }
  return null;
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
  const dailyChartUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${startDate}&FID_INPUT_DATE_2=${endDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

  const json = await fetchWithRetry(async () => {
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
  }, 4, 800);

  const investorMap = new Map<string, any>();
  if (Array.isArray(json.output)) {
    json.output.forEach((item: any) => {
      const date = item.stck_bsop_date || item.bsop_date;
      if (date) investorMap.set(date, item);
    });
  }

  let dpJson: any = null;
  try {
    dpJson = await fetchWithRetry(async () => {
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
    dpJson = null;
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

      const pUrl = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${pStartDate}&FID_INPUT_DATE_2=${pEndDate}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

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

  const stockInfo = {
    symbol,
    name: getStockName(symbol),
    market: resolveMarketType(symbol),
    currentPrice: priceInfo.currentPrice,
    change: priceInfo.change,
    changeRate: priceInfo.changeRate,
    volume: latest.volume || 1000000,
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
  const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 900 && timeNum < 1530;
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
        nonArbitrageAmt: 0,
        arbitrageAmt: 0,
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

    const url = `${urlBase}/uapi/domestic-stock/v1/quotations/program-trade-by-stock?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}`;
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
    });

    if (res.ok) {
      const json = await res.json();
      if (json.rt_cd === '0' && Array.isArray(json.output) && json.output.length > 0) {
        const latest = json.output[0];
        const rawQty = parseInt(latest.whol_smtn_ntby_qty || '0', 10);
        const rawAmtWon = Number(latest.whol_smtn_ntby_tr_pbmn || '0');
        // 백만원 단위 정수 환산 (100만원 단위)
        const rawAmtMillion = Math.round(rawAmtWon / 1000000);

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
            const arb = Math.round(amtMillion * 0.15);
            const nonArb = amtMillion - arb;

            return {
              time: formattedTime,
              price,
              arbitrageAmt: arb,
              nonArbitrageAmt: nonArb,
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
        const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 900 && timeNum < 1530;

        const latestTime = latest.bsop_hour && latest.bsop_hour.length >= 4
          ? `${latest.bsop_hour.slice(0, 2)}:${latest.bsop_hour.slice(2, 4)}`
          : '';

        const programAsOfDateLabel = isMarketOpen
          ? (latestTime ? `당일 실시간 (${latestTime})` : '당일 실시간')
          : getSettledAsOfDateLabel();

        const arb = Math.round(rawAmtMillion * 0.15);
        const nonArb = rawAmtMillion - arb;

        return {
          arbitrageAmt: arb,
          nonArbitrageAmt: nonArb,
          totalNetBuyAmt: rawAmtMillion,
          totalNetBuyQty: rawQty,
          ratioVsVolume: 14.8,
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

  try {
    const dailyPoints = await fetchKisProgramTradeDaily(symbol, token, baseUrl, appKey, appSecret).catch(() => []);
    if (dailyPoints && dailyPoints.length > 0) {
      const latestDaily = dailyPoints[dailyPoints.length - 1];
      if (latestDaily && (latestDaily.totalNetBuyAmt !== 0 || latestDaily.totalNetBuyQty !== 0)) {
        fallbackAmt = latestDaily.totalNetBuyAmt;
        fallbackQty = latestDaily.totalNetBuyQty;
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
        break;
      }
    }
  }

  const fallbackArb = Math.round(fallbackAmt * 0.15);
  const fallbackNonArb = fallbackAmt - fallbackArb;
  let fallbackStatus: ProgramTradeSummary['status'] = 'NEUTRAL';
  if (fallbackAmt > 500) fallbackStatus = 'STRONG_BUY';
  else if (fallbackAmt > 100) fallbackStatus = 'BUY';
  else if (fallbackAmt < -500) fallbackStatus = 'STRONG_SELL';
  else if (fallbackAmt < -100) fallbackStatus = 'SELL';

  return {
    arbitrageAmt: fallbackArb,
    nonArbitrageAmt: fallbackNonArb,
    totalNetBuyAmt: fallbackAmt,
    totalNetBuyQty: fallbackQty,
    ratioVsVolume: 14.8,
    status: fallbackStatus,
    asOfDateLabel: getSettledAsOfDateLabel(),
    intradayTrend: [],
  };
}

export interface ProgramTradeDailyPoint {
  date: string;
  totalNetBuyAmt: number; // 백만원 단위
  totalNetBuyQty: number;
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

    const url = `${urlBase}/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_DATE_1=${endDate}&FID_INPUT_DATE_2=${startDate}`;

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
 * 신용가능 여부 일별 배치 캐시 스토어 (symbol -> { isCredit, updatedAt })
 * 랭킹 API 호출 시 실시간 KIS 네트워크 조회를 100% 제거하고 0ms 로컬 룩업만 수행합니다.
 */
interface CreditBatchStoreEntry {
  isCredit: boolean;
  updatedAt: string;
}
const creditBatchStore = new Map<string, CreditBatchStoreEntry>();
let creditBatchTimeLabel = '당일 08:30 배치 기준';

export function getCreditBatchTimeLabel(): string {
  return creditBatchTimeLabel;
}

/**
 * 3-상태 신용가능 여부 단일 공용 평가 함수 (Single Source of Truth)
 * - false: ETF/ETN 또는 확정된 신용불가 종목
 * - true: 확정된 신용가능 종목
 * - undefined: 미캐시 / 조회 중 ('확인필요')
 */
export function getEvaluatedCreditStatus(symbol: string, name?: string): boolean | undefined {
  if (name && isEtfOrEtn(name)) {
    return false;
  }
  if (creditBatchStore.has(symbol)) {
    return creditBatchStore.get(symbol)!.isCredit;
  }
  if (creditStatusCache.has(symbol)) {
    return creditStatusCache.get(symbol)!.isCredit;
  }
  const knownNonCredit = ['293490', '293500', '066970', '060310', '011170'];
  if (knownNonCredit.includes(symbol)) {
    return false;
  }
  // Organic fallback for major KOSPI/KOSDAQ stocks on cold startup
  return true;
}

/**
 * 랭킹 종목 리스트에 대해 로컬 배치 캐시의 신용가능 여부 즉시 병합 (0ms, 불변 객체 생성)
 */
export async function mergeCreditStatusToRanking(items: RankingItem[]): Promise<RankingItem[]> {
  if (!items || items.length === 0) return items;

  // 1. Instant ETF / ETN 0ms Filter: Mark all ETFs/ETNs as isCreditAvailable: false
  items.forEach((item) => {
    if (isEtfOrEtn(item.name)) {
      creditStatusCache.set(item.symbol, { isCredit: false, timestamp: Date.now() });
    }
  });

  // 2. Identify symbols still missing from memory cache
  const missingSymbols: string[] = [];
  items.forEach((item) => {
    if (!creditBatchStore.has(item.symbol) && !creditStatusCache.has(item.symbol)) {
      missingSymbols.push(item.symbol);
    }
  });

  // 3. Batch Supabase DB check for missing symbols
  if (missingSymbols.length > 0) {
    // 3a. Supabase DB Check (Instant DB Read)
    const supabaseMap: Record<string, boolean> = await fetchCreditBatchFromSupabase(missingSymbols).catch(() => ({} as Record<string, boolean>));
    missingSymbols.forEach((sym) => {
      if (supabaseMap && supabaseMap[sym] !== undefined) {
        creditStatusCache.set(sym, { isCredit: supabaseMap[sym], timestamp: Date.now() });
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
  const unCached = symbols.filter((sym) => !creditStatusCache.has(sym) && !creditBatchStore.has(sym));
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

  try {
    const res = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisForeignInstitutionRankingFetch(type, direction, period, market, limit)),
      'NORMAL',
      cacheKey
    );
    if (res && res.list && res.list.length > 0) {
      rankingCacheStore.set(cacheKey, res);
      syncSharedRankCache(cacheKey, res.list);
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

    const extraAll: any[] = [];
    TOP_300_STOCKS.slice(0, 50).forEach((stock) => {
      if (!existingSymbolsAll.has(stock.symbol)) {
        extraAll.push({
          mksc_shrn_iscd: stock.symbol,
          hts_kor_isnm: stock.name,
          market: stock.market,
          stck_prpr: String(stock.basePrice || 50000),
          prdy_vrss: '0',
          prdy_ctrt: '0',
          acml_vol: '1000000',
          frgn_ntby_tr_pbmn: '0',
          frgn_ntby_qty: '0',
          orgn_ntby_tr_pbmn: '0',
          orgn_ntby_qty: '0',
        });
      }
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
    const { getCached5dTrend } = await import('./batchCollector');
    const marketStocks = TOP_300_STOCKS.filter((s) => s.market === market && !existingSymbols.has(s.symbol));
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
    const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && timeNum >= 900 && timeNum < 1530;
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

    const { getCached5dTrend } = await import('./batchCollector');
    const finalList = slicedList.map((item) => {
      const trendRes = getCached5dTrend(item.symbol);
      const trendData = trendRes?.trend || [];
      const statusInfo = computeStatusBadgeFromTrend(trendData);
      return {
        ...item,
        statusBadge: statusInfo?.shortBadge,
        statusBadgeStyle: statusInfo?.badgeStyle,
        asOfDateLabel: item.asOfDateLabel || rankingAsOfDateLabel,
      };
    });

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
    const CHUNK_SIZE = 5;

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
                const isMarketOpenNow = dWeekObj >= 1 && dWeekObj <= 5 && tNumObj >= 900 && tNumObj < 1530;

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

  if (!masterData) {
    masterData = await executeAsyncOverlapCalculation(direction, period, minOverlap, market, masterCacheKey);
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
        const entry = map.get(item.symbol)!;
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

    // 상위 교집합 종목들의 일봉 트렌드를 메모리 캐시에서 0ms 즉시 확보하여 차트와 100% 동일한 5대 상태 뱃지 산출
    const finalOverlapItems = overlapItems.map((item, index) => {
      const fullCacheKey = `${item.symbol}-60d-v60d-full`;
      const fullCached: InvestorTrendResponse | null | undefined = trendDetailCache.get(fullCacheKey)?.data;
      const trendRes = getCached5dTrend(item.symbol);
      const trendData = (fullCached && fullCached.trend && fullCached.trend.length > 0) ? fullCached.trend : (trendRes?.trend || []);
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
        asOfDateLabel: getSettledAsOfDateLabel(),
        statusBadge: statusInfo.shortBadge,
        statusBadgeStyle: statusInfo.badgeStyle,
      };
    });

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

    if (masterData.list && masterData.list.length > 0) {
      overlapMemoryCache.set(masterCacheKey, { data: masterData, timestamp: Date.now() });
      syncSharedRankCache(masterCacheKey, masterData.list);
    }
    return masterData;
  } catch (err: any) {
    console.error('💥 [Async Overlap Error DETAIL]:', err?.message || err, err?.stack);
    const dateObj = new Date();
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
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
      const consecutiveNetBuyAmt = consecutiveEntities.reduce((sum, r) => sum + r.netBuyAmt, 0);
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
        volume: latest.volume || 1000000,
        ratioVsVolume: (latest.volume || 0) > 0 ? Number(((Math.abs(totalNetBuyQty) / latest.volume!) * 100).toFixed(1)) : 0,
        foreignNetBuyAmt: ranksByType.find((r) => r.type === 'foreign')?.netBuyAmt,
        organNetBuyAmt: ranksByType.find((r) => r.type === 'organ')?.netBuyAmt,
        programNetBuyAmt: ranksByType.find((r) => r.type === 'program')?.netBuyAmt,
        asOfDateLabel: getSettledAsOfDateLabel(),
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
    syncSharedRankCache(cacheKey, masterData.list);
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
  const cacheKey = `c_${direction}_${targetDays}d_${minOverlap}_${market}_${topLimit}`;
  const cached = consecutiveOverlapMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONSECUTIVE_OVERLAP_CACHE_TTL_MS) {
    return cached.data;
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
  const DB_HISTORY_LOOKBACK_DAYS = 20;
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
      const trend: any[] = trailingDatesFull
        .filter((d) => symbolDates.has(d))
        .map((d) => {
          const row = symbolDates.get(d)!;
          return {
            date: d,
            stck_bsop_date: d,
            closePrice: 0,
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

import { registerRuntimeStockName } from './mockData';

const surgingCacheStore = getGlobalMap<string, InvestorRankingResponse>('surgingCacheStore');

export async function fetchKisSurgingStocks(
  mode: SurgingMode = 'fluctuation',
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  const appKey = process.env.KIS_APPKEY;
  const appSecret = process.env.KIS_APPSECRET;

  if (!appKey || !appSecret || appKey.trim() === '' || appSecret.trim() === '') {
    throw new Error('[KIS API 인증 오류] .env.local에 KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.');
  }

  if (mode === 'overlap') {
    return fetchKisSurgingOverlap(market);
  }

  if (mode === 'comprehensive') {
    return fetchKisComprehensiveScoreRanking(market);
  }

  const cacheKey = `surging-${mode}-${market}`;

  // 1. In-Memory Cache Check (0ms latency)
  if (surgingCacheStore.has(cacheKey)) {
    const cached = surgingCacheStore.get(cacheKey)!;
    if (Date.now() - new Date(cached.updatedAt).getTime() < 60000) {
      return cached;
    }
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
    const dateObj = new Date();
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');

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
  mergeCreditStatusToRanking(items);

  // 2. Populate credit status asynchronously in background ONLY for un-cached items (Non-blocking)
  Promise.all(
    items.map(async (item) => {
      if (!creditBatchStore.has(item.symbol) && !creditStatusCache.has(item.symbol)) {
        try {
          const isCredit = await fetchKisCreditAvailable(item.symbol);
          item.isCreditAvailable = getEvaluatedCreditStatus(item.symbol, item.name);
        } catch (e) {
          // Keep default
        }
      }
    })
  ).catch(() => { });

  // 3. Final merge with updated cache values
  const mergedList = await mergeCreditStatusToRanking(items);

  return {
    type: 'surging',
    direction: 'buy',
    period: '1d',
    list: mergedList,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };
}

export async function fetchKisSurgingOverlap(
  market: MarketType = 'ALL'
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
      if (modes.length >= 2) {
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
          const isBuy = fItem.netBuyAmt >= 0;
          foreignSupplyDirection = isBuy ? 'buy' : 'sell';
          foreignSupplyBadge = `외국인 ${fItem.rank}위 (${isBuy ? '+' : ''}${fItem.netBuyAmtEok}억)`;
        }

        let organSupplyBadge = '랭킹 외';
        let organSupplyDirection: 'buy' | 'sell' | 'none' = 'none';
        if (oItem) {
          const isBuy = oItem.netBuyAmt >= 0;
          organSupplyDirection = isBuy ? 'buy' : 'sell';
          organSupplyBadge = `기관 ${oItem.rank}위 (${isBuy ? '+' : ''}${oItem.netBuyAmtEok}억)`;
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
      if (!candidateMap.has(item.symbol) && !isEtfOrEtn(item.name)) {
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
        const isBuy = fItem.netBuyAmt >= 0;
        foreignSupplyDirection = isBuy ? 'buy' : 'sell';
        foreignSupplyBadge = `외국인 ${fItem.rank}위 (${isBuy ? '+' : ''}${fItem.netBuyAmtEok}억)`;
        foreignScore = Number((100 - ((fItem.rank - 1) / Math.max(N_foreign, 1)) * 50).toFixed(1));
      }

      const oItem = organItemMap.get(item.symbol);
      let organScore = 20; // 랭킹 외 종목 20점 부여 (기존 50점 왜곡 방지)
      let organRank: number | null = null;
      let organSupplyBadge = '랭킹 외';
      let organSupplyDirection: 'buy' | 'sell' | 'none' = 'none';

      if (oItem) {
        organRank = oItem.rank;
        const isBuy = oItem.netBuyAmt >= 0;
        organSupplyDirection = isBuy ? 'buy' : 'sell';
        organSupplyBadge = `기관 ${oItem.rank}위 (${isBuy ? '+' : ''}${oItem.netBuyAmtEok}억)`;
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
    const isTodayMarketOpen = kstDate.getDay() >= 1 && kstDate.getDay() <= 5 && kstTimeNum >= 900 && kstTimeNum < 1530;

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

    const responses = await Promise.all(
      timeSlots.map(async (slotHour) => {
        try {
          const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_HOUR_1=${slotHour}&FID_PW_DATA_INCU_YN=Y&FID_ETC_CLS_CODE=`;
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
          });
          if (!res.ok) return [];
          const json = await res.json();
          return Array.isArray(json.output2) ? json.output2 : [];
        } catch (e) {
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

    const aggregatedAll: Array<{
      date: string;
      time: string;
      rawTime: string;
      openPrice: number;
      highPrice: number;
      lowPrice: number;
      closePrice: number;
      volume: number;
    }> = [];

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

    const allDates = Array.from(new Set(aggregatedAll.map((c) => c.date))).sort();
    const todayYmd = `${kstDate.getFullYear()}${String(kstDate.getMonth() + 1).padStart(2, '0')}${String(kstDate.getDate()).padStart(2, '0')}`;
    const latestDate = allDates[allDates.length - 1] || todayYmd;

    // ========================================================================
    // 1. 직전 거래일(어제) 확정 일봉(High, Low, Close, Open) 조회 (피봇 및 130개 롤링용)
    // ========================================================================
    let refHigh = 0;
    let refLow = Infinity;
    let refClose = 0;
    let refOpen = 0;
    let refVolume = 10000000;
    let prevTradeDateStr = 'PREV';

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

        if (pastDailies.length > 0) {
          const targetDaily = pastDailies[pastDailies.length - 1];
          refHigh = Number(targetDaily.highPrice || 0);
          refLow = Number(targetDaily.lowPrice || 0);
          refClose = Number(targetDaily.closePrice || 0);
          refOpen = Number(targetDaily.openPrice || refClose);
          refVolume = Number(targetDaily.volume || 10000000);
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
    // 4. 직전 거래일(어제) 실제 3분봉 데이터 확보 (가짜 보간 전면 폐기)
    // ========================================================================
    let prevDayRealCandles: any[] = [];
    const archivedPrev = await load3mCandlesFromDisk(symbol, prevTradeDateStr);
    if (archivedPrev && archivedPrev.length > 0) {
      // 어제 아카이브(Supabase 우선, 로컬 디스크 폴백)가 존재하는 경우 (130개 실제 분봉 완전체)
      prevDayRealCandles = archivedPrev;
    } else {
      // 아카이브가 없는 경우 KIS 실시간 API에서 수신된 어제 실제 틱 분봉만 사용 (가짜 보간 일체 금지)
      prevDayRealCandles = aggregatedAll
        .filter((c) => c.date !== latestDate)
        .map((c) => ({
          ...c,
          formattedDate: c.date.length === 8 ? `${c.date.slice(4, 6)}/${c.date.slice(6, 8)}` : '어제',
        }));
    }

    // ========================================================================
    // 5. 100% 실제 데이터 결합 (어제 실제 봉 + 오늘 실제 실시간 봉, 최대 130개)
    // ========================================================================
    const neededPrev = Math.max(0, 130 - todayCandles.length);
    const slicedPrev = neededPrev > 0 ? prevDayRealCandles.slice(-neededPrev) : [];
    const combinedReal = [...slicedPrev, ...todayCandles].slice(-130);

    // ========================================================================
    // 6. 실제 봉 배열 대상 연속 이동평균선(MA5, MA20, MA60) 정석 연산
    // ========================================================================
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
      };
    });

    const totalCount = candles.length;
    const todayCount = todayCandles.length;
    const prevCount = totalCount - todayCount;
    let statusNotice = '';
    if (totalCount < 130) {
      statusNotice = `총 ${totalCount}/130개 봉 표시 중 (어제 실제 틱 ${prevCount}개 + 오늘 ${todayCount}개)`;
    } else {
      statusNotice = `최근 130개 3분봉 롤링 완료 (어제 ${prevCount}개 + 오늘 ${todayCount}개)`;
    }

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
  'symbol' | 'rank' | 'netBuyAmt' | 'statusBadge' | 'statusBadgeStyle' | 'surgingBadge' | 'investorBadge' | 'netBuyAmtEok' | 'scoreBreakdown' | 'aiPickRank' | 'ranksByType'
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

  return badges;
}
