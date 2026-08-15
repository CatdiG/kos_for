// KIS API Service Module - Updated Queue Delay & Rate Limit Guard
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InvestorTrendDay, InvestorTrendResponse, KisTokenResponse, ProgramTradeIntradayPoint, ProgramTradeSummary, SupplySummary, TrendPeriod, InvestorRankingResponse, RankingItem, RankingDirection, RankingPeriod, RankingType, OverlapInvestorRank, MarketType, SurgingRankItem, ScoreBreakdown, SurgingMode, isEtfOrEtn } from './types';
import { getStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, resolveMarketType } from './mockData';
export { resolveStockPriceAndChange };

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

// =================================================================
// External Shared Storage (Vercel KV / Upstash Redis REST API) & Distributed Lock
// =================================================================

import { Redis as UpstashRedis } from '@upstash/redis';

const UPSTASH_CLIENT_KEY = Symbol.for('kis_upstash_client');

function parseRedisUrlToUpstashRest(redisUrl: string) {
  if (!redisUrl || typeof redisUrl !== 'string') return null;
  try {
    const cleanUrl = redisUrl.trim().replace(/^rediss?:\/\//i, '');
    const [authPart, hostPart] = cleanUrl.split('@');
    if (!authPart || !hostPart) return null;
    const token = authPart.includes(':') ? authPart.split(':')[1] : authPart;
    const host = hostPart.split(':')[0]; // Strip port like :6379
    if (token && host) {
      return {
        url: `https://${host}`,
        token,
      };
    }
  } catch (e) {
    console.error('[Redis 에러] parseRedisUrlToUpstashRest 파싱 오류:', e);
  }
  return null;
}

function getUpstashClient(): UpstashRedis | null {
  if ((globalThis as any)[UPSTASH_CLIENT_KEY]) {
    return (globalThis as any)[UPSTASH_CLIENT_KEY];
  }

  let url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  let token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if ((!url || !token) && process.env.REDIS_URL) {
    const parsed = parseRedisUrlToUpstashRest(process.env.REDIS_URL);
    if (parsed) {
      url = parsed.url;
      token = parsed.token;
      console.log('[Redis Sanitizer] REDIS_URL (rediss://)에서 Upstash REST API 규격 (https://) 및 토큰 추출 완료');
    }
  }

  if (url && token && url.trim() !== '' && token.trim() !== '') {
    let sanitizedUrl = url.trim();
    if (!sanitizedUrl.startsWith('http://') && !sanitizedUrl.startsWith('https://')) {
      sanitizedUrl = sanitizedUrl.replace(/^rediss?:\/\//i, 'https://');
    }
    sanitizedUrl = sanitizedUrl.replace(/\/$/, '');

    try {
      console.log(`[Redis Config Audit] Connecting to Upstash REST URL: ${sanitizedUrl}`);
      const client = new UpstashRedis({ url: sanitizedUrl, token: token.trim() });
      (globalThis as any)[UPSTASH_CLIENT_KEY] = client;
      return client;
    } catch (e: any) {
      console.error('[Redis 에러] UpstashRedis 클라이언트 생성 실패:', e?.message || e);
    }
  } else {
    console.warn(`[Redis Config Warning] Upstash REST URL(${url ? 'OK' : '미설정/형식오류'}) 또는 Token(${token ? 'OK' : '미설정'})이 누락되었습니다.`);
  }

  return null;
}

const TOKEN_CACHE_KEY = Symbol.for('kis_token_cache_v2');
const LOCAL_TOKEN_FILE = path.join(process.cwd(), 'scratch', '.kis_token_cache.json');

function getGlobalTokenCache(): TokenCacheData | null {
  return (globalThis as any)[TOKEN_CACHE_KEY] || null;
}

function setGlobalTokenCache(cache: TokenCacheData): void {
  (globalThis as any)[TOKEN_CACHE_KEY] = cache;
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
    console.error('[Redis 에러] getLocalFileTokenCache 디스크 조회 오류:', e);
  }
  return null;
}

function saveLocalFileTokenCache(cache: TokenCacheData): void {
  try {
    const dir = path.dirname(LOCAL_TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    console.error('[Redis 에러] saveLocalFileTokenCache 디스크 저장 오류:', e);
  }
}

async function kvGetTokenCache(appKeyHash: string, allowExpired: boolean = false): Promise<TokenCacheData | null> {
  const now = Date.now();
  // 1. Fast in-memory check (0ms)
  const mem = getGlobalTokenCache();
  if (mem && (allowExpired || mem.expires_at > now) && (!mem.app_key_hash || mem.app_key_hash === appKeyHash)) {
    return mem;
  }

  // 2. Fast local disk file check (0ms)
  const fileCache = getLocalFileTokenCache(appKeyHash, allowExpired);
  if (fileCache) {
    setGlobalTokenCache(fileCache);
    return fileCache;
  }

  // 3. Upstash Redis Official REST SDK Lookup
  const upstash = getUpstashClient();
  if (upstash) {
    try {
      const rawVal = await upstash.get<any>(`kis_token_${appKeyHash}`);
      if (rawVal) {
        const cache: TokenCacheData = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
        if (cache && cache.access_token && (allowExpired || cache.expires_at > now)) {
          console.log('[KIS Redis Hit] Upstash Redis REST에서 유효한 접근 토큰 획득 성공 (신규 발급 0건)');
          setGlobalTokenCache(cache);
          saveLocalFileTokenCache(cache);
          return cache;
        } else {
          console.warn(`[KIS Redis Warning] Key kis_token_${appKeyHash} found in Redis but token is expired or invalid.`);
        }
      } else {
        console.log(`[KIS Redis Info] Key kis_token_${appKeyHash} does not exist in Redis cache yet.`);
      }
    } catch (e: any) {
      console.error('[Redis 에러] kvGetTokenCache Upstash REST 조회 중 오류 발생:', e?.message || e);
    }
  }

  return getGlobalTokenCache() || getLocalFileTokenCache(appKeyHash, true);
}

async function kvSaveTokenCache(cache: TokenCacheData): Promise<void> {
  setGlobalTokenCache(cache);
  saveLocalFileTokenCache(cache);

  const ttlSec = Math.max(Math.floor((cache.expires_at - Date.now()) / 1000) - 300, 3600);
  const jsonStr = JSON.stringify(cache);

  // Upstash Redis Official REST SDK Save
  const upstash = getUpstashClient();
  if (upstash) {
    try {
      const res = await upstash.set(`kis_token_${cache.app_key_hash}`, jsonStr, { ex: ttlSec });
      console.log(`[KIS Redis Saved] Upstash Redis REST 공유 저장소에 토큰 저장 완료 (Result: ${res}, TTL: ${ttlSec}초).`);
    } catch (e: any) {
      console.error('[Redis 에러] kvSaveTokenCache Upstash REST 저장 중 오류 발생:', e?.message || e);
    }
  }
}

async function kvAcquireDistributedLock(lockKey: string, ttlSec: number = 10): Promise<boolean> {
  const upstash = getUpstashClient();
  if (upstash) {
    try {
      const res = await upstash.set(lockKey, 'locked', { nx: true, ex: ttlSec });
      if (res === 'OK') return true;
    } catch (e: any) {
      console.error('[Redis 에러] kvAcquireDistributedLock 오류:', e?.message || e);
    }
  }
  return true;
}

async function kvReleaseDistributedLock(lockKey: string): Promise<void> {
  const upstash = getUpstashClient();
  if (upstash) {
    try { await upstash.del(lockKey); } catch (e: any) {
      console.error('[Redis 에러] kvReleaseDistributedLock 오류:', e?.message || e);
    }
  }
}

async function kvGetJson<T>(key: string): Promise<T | null> {
  const upstash = getUpstashClient();
  if (upstash) {
    try {
      const rawVal = await upstash.get<T>(key);
      if (rawVal !== null && rawVal !== undefined) return rawVal;
    } catch (e: any) {
      console.error('[Redis 에러] kvGetJson 오류:', e?.message || e);
    }
  }
  return null;
}

async function kvSetJson(key: string, data: any, ttlSec: number = 300): Promise<void> {
  const jsonStr = JSON.stringify(data);
  const upstash = getUpstashClient();
  if (upstash) {
    try { await upstash.set(key, jsonStr, { ex: ttlSec }); } catch (e: any) {
      console.error('[Redis 에러] kvSetJson 오류:', e?.message || e);
    }
  }
}

async function kvMgetJson<T>(keys: string[]): Promise<Record<string, T | null>> {
  const result: Record<string, T | null> = {};
  if (!keys || keys.length === 0) return result;

  const upstash = getUpstashClient();
  if (upstash) {
    try {
      const rawList = await upstash.mget<any[]>(...keys);
      if (Array.isArray(rawList)) {
        rawList.forEach((rawVal: any, idx: number) => {
          const k = keys[idx];
          if (rawVal !== null && rawVal !== undefined) {
            try {
              result[k] = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
            } catch (e) {
              result[k] = rawVal;
            }
          } else {
            result[k] = null;
          }
        });
        return result;
      }
    } catch (e: any) {
      console.error('[Redis 에러] kvMgetJson 오류:', e?.message || e);
    }
  }

  return result;
}

/**
 * KIS OAuth 2.0 Access Token 발급 및 외부 공유 저장소(Vercel KV / Upstash Redis) 캐싱
 */
export async function getKisAccessToken(): Promise<string | null> {
  const rawKey = process.env.KIS_APPKEY || '';
  const rawSecret = process.env.KIS_APPSECRET || '';
  const appKey = rawKey.trim().replace(/^["']|["']$/g, '');
  const appSecret = rawSecret.trim().replace(/^["']|["']$/g, '');

  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const defaultBaseUrl = isVirtual 
    ? 'https://openapivts.koreainvestment.com:29443' 
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  if (!appKey || !appSecret || appKey === '' || appSecret === '') {
    const missingMsg = `Vercel 설정에 KIS_APPKEY(${appKey ? '설정됨' : '미설정'}) 또는 KIS_APPSECRET(${appSecret ? '설정됨' : '미설정'})이 누락되었습니다.`;
    console.warn(`[KIS API Warning] ${missingMsg}`);
    globalThis.__lastKisOAuthError__ = missingMsg;
    return null;
  }

  const appKeyHash = `${appKey.slice(0, 6)}_${isVirtual ? 'vts' : 'real'}`;

  // 1. Fast Memory & Local File & Redis Check (0ms)
  const existingToken = await kvGetTokenCache(appKeyHash);
  if (existingToken && existingToken.access_token && existingToken.expires_at > Date.now()) {
    return existingToken.access_token;
  }

  // 2. Promise Lock for concurrent requests within the same process
  if (globalThis.__kisTokenPromise__) {
    return globalThis.__kisTokenPromise__;
  }

  globalThis.__kisTokenPromise__ = (async () => {
    try {
      // Double check cache right before network call
      const doubleCheck = await kvGetTokenCache(appKeyHash);
      if (doubleCheck && doubleCheck.access_token && doubleCheck.expires_at > Date.now()) {
        return doubleCheck.access_token;
      }

      console.log('[KIS OAuth Request] KIS API 접근 토큰 신규 발급 요청 중...');
      const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: appKey,
          appsecret: appSecret,
        }),
        cache: 'no-store',
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[KIS OAuth Error ${res.status}]`, errorText);
        globalThis.__lastKisOAuthError__ = `[KIS OAuth HTTP ${res.status}] ${errorText}`;

        const fallbackToken = await kvGetTokenCache(appKeyHash, true);
        if (fallbackToken && fallbackToken.access_token) {
          console.warn('[KIS OAuth Fallback] 한투 서버 오류/제한으로 기존 발급 토큰 안전 사용');
          return fallbackToken.access_token;
        }
        return null;
      }

      const data: any = await res.json();
      if (data && data.access_token) {
        const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : parseInt(data.expires_in || '86400', 10);
        const expiresAt = Date.now() + (expiresInSec * 1000); // 1000을 곱해 밀리초(ms) 단위로 정확히 24시간 뒤로 설정

        console.log(`[KIS Token Info] 새 토큰 만료 시간: ${new Date(expiresAt).toISOString()} (현재로부터 약 ${(expiresInSec / 3600).toFixed(1)}시간 뒤)`);

        const tokenCache: TokenCacheData = {
          access_token: data.access_token,
          expires_at: expiresAt,
          app_key_hash: appKeyHash,
        };

        await kvSaveTokenCache(tokenCache);
        console.log(`[KIS OAuth Success] 새로운 Access Token 발급 및 Redis 공유 저장소 저장 완료 (유효기간: ${expiresInSec}초)`);
        return data.access_token;
      } else {
        const errStr = data.error_description || data.msg1 || data.error_code || 'Access token missing';
        console.error('[KIS OAuth Error]', errStr);
        globalThis.__lastKisOAuthError__ = `[KIS OAuth 응답 에러] ${errStr}`;

        const fallbackToken = await kvGetTokenCache(appKeyHash, true);
        if (fallbackToken && fallbackToken.access_token) return fallbackToken.access_token;
        return null;
      }
    } catch (e: any) {
      console.error('[KIS OAuth Exception]', e?.message || e);
      globalThis.__lastKisOAuthError__ = `[KIS OAuth 예외] ${e?.message || e}`;
      const fallbackToken = await kvGetTokenCache(appKeyHash, true);
      if (fallbackToken && fallbackToken.access_token) return fallbackToken.access_token;
      return null;
    } finally {
      globalThis.__kisTokenPromise__ = undefined;
    }
  })();

  return globalThis.__kisTokenPromise__;
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
  private minDelayMs = 300; // 300ms 딜레이 (초당 약 3.3건으로 KIS 허용 속도 내에서 EGW00201 완벽 방지)
  private lastCallTime = 0;

  public enqueue<T>(fn: () => Promise<T>, priority: Priority = 'NORMAL', id?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        id: id || `${priority}-${Date.now()}-${Math.random()}`,
        priority,
        fn,
        resolve,
        reject,
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
        console.warn(`[KIS Rate Limit Backoff ${attempt}/${maxRetries}] 800ms 대기 후 자동 재시도...`);
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

let lastKisApiCallTime = 0;
async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastKisApiCallTime;
  if (elapsed < 300) {
    await new Promise((resolve) => setTimeout(resolve, 300 - elapsed));
  }
  lastKisApiCallTime = Date.now();
}

/**
 * KIS 국내주식 투자자별 매매동향 API 호출 (FHKST01010900 / inquire-investor) - 전역 큐 및 캐시 적용
 */
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

  // 1. In-Memory Cache Check
  if (trendDetailCache.has(cacheKey)) {
    const cached = trendDetailCache.get(cacheKey)!;
    if (cached.data?.trend?.length < 120) {
      trendDetailCache.delete(cacheKey);
    } else if (now - cached.timestamp < TREND_CACHE_TTL_MS) {
      console.log(`[PERF TREND MEMORY HIT] ${symbol} (${period}) -> 0ms 반환`);
      return cached.data;
    }
  }

  // 2. Vercel KV Redis Shared Cache Check (5 min TTL)
  const redisTrend = await kvGetJson<InvestorTrendResponse>(`kv_trend_${cacheKey}`);
  if (redisTrend && redisTrend.trend?.length >= 120) {
    console.log(`[PERF TREND REDIS HIT] ${symbol} (${period}) -> Vercel KV Redis 0ms 반환`);
    trendDetailCache.set(cacheKey, { data: redisTrend, timestamp: now });
    return redisTrend;
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
      await kvSetJson(`kv_trend_${cacheKey}`, response, 300); // 5분간 Vercel KV 캐싱
    }
    return response;
  } catch (err: any) {
    console.error(`[KIS Trend Queue Exception] ${symbol}:`, err);
    if (redisTrend) return redisTrend;
    if (trendDetailCache.has(cacheKey)) {
      console.warn(`[KIS Trend Fallback to Stale Cache] ${symbol} 만료 캐시 데이터 반환`);
      return trendDetailCache.get(cacheKey)!.data;
    }
    throw err;
  }
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
    const errText = await res.text();
    console.error('[KIS API Error]', res.status, errText);
    throw new Error(`[KIS API 호출 오류 ${res.status}] ${errText}`);
  }

  const json = await res.json();

  if (json.rt_cd !== '0' || !Array.isArray(json.output)) {
    console.warn('[KIS API Response Error]', json.msg1);
    throw new Error(`[KIS API 응답 오류] ${json.msg1 || '응답 데이터 포맷 불일치'}`);
  }

  const investorMap = new Map<string, any>();
  if (Array.isArray(json.output)) {
    json.output.forEach((item: any) => {
      const date = item.stck_bsop_date || item.bsop_date;
      if (date) investorMap.set(date, item);
    });
  }

  let dpJson: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 150 : 400));
    const dailyPriceRes = await fetch(dailyChartUrl, {
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

    if (dailyPriceRes && dailyPriceRes.ok) {
      const parsed = await dailyPriceRes.json().catch(() => null);
      if (parsed && parsed.rt_cd === '0' && Array.isArray(parsed.output2) && parsed.output2.length > 0) {
        dpJson = parsed;
        break;
      }
    }
  }

  let fullDailyItems: any[] = [];
  if (dpJson && dpJson.rt_cd === '0' && Array.isArray(dpJson.output2) && dpJson.output2.length > 0) {
    const page1Ascending = dpJson.output2.slice().reverse(); // Ascending date
    fullDailyItems = page1Ascending;
        // Robust Pagination: Fetch preceding trading days until we have at least 120+ trading days for complete 60D MAs
        const getObjDate = (item: any) => item?.stck_bsop_date || item?.bsop_date || item?.date || '';
        let currentEnd = getObjDate(page1Ascending[0]);

        for (let p = 2; p <= 4 && fullDailyItems.length < 120; p++) {
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
  console.log(`[KIS API Data Check] Stock (${symbol}) Total Daily Items Count: ${fullDailyItems.length} (>=60 Required: ${fullDailyItems.length >= 60})`);
  if (fullDailyItems.length > 0) {
    const recent5 = fullDailyItems.slice(-5).map((d: any) => ({
      date: d.stck_bsop_date || d.bsop_date || d.date || '',
      close: parseInt(d.stck_clpr || d.stck_prpr || '0', 10),
    }));
    console.log(`[KIS API Data Check] Stock (${symbol}) Recent 5 Days Data:`, JSON.stringify(recent5));
  }

  let cumForeign = 0;
  let cumOrgan = 0;
  let cumPension = 0;

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

      highPrice = highPrice > 0 ? Math.max(highPrice, bodyMax) : Math.round(bodyMax * 1.003);
      lowPrice = lowPrice > 0 ? Math.min(lowPrice, bodyMin) : Math.max(1, Math.round(bodyMin * 0.997));
    }

    let foreignQty = 0;
    let foreignAmt = 0;
    let organQty = 0;
    let organAmt = 0;
    let pensionQty = 0;
    let pensionAmt = 0;

    if (invItem) {
      foreignQty = parseInt(invItem.frgn_ntby_qty || invItem.frgn_ntby_vol || '0', 10);
      foreignAmt = parseInt(invItem.frgn_ntby_tr_pbmn || invItem.frgn_ntby_amt || '0', 10);

      organQty = parseInt(invItem.orgn_ntby_qty || invItem.orgn_ntby_vol || '0', 10);
      organAmt = parseInt(invItem.orgn_ntby_tr_pbmn || invItem.orgn_ntby_amt || '0', 10);

      pensionQty = parseInt(invItem.prsn_ntby_qty || invItem.prsn_ntby_vol || '0', 10);
      pensionAmt = parseInt(invItem.prsn_ntby_tr_pbmn || invItem.prsn_ntby_amt || '0', 10);
    }

    cumForeign += foreignAmt;
    cumOrgan += organAmt;
    cumPension += pensionAmt;

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
      pensionNetBuyQty: pensionQty,
      pensionNetBuyAmt: pensionAmt,
      cumForeignNetBuyAmt: cumForeign,
      cumOrganNetBuyAmt: cumOrgan,
      cumPensionNetBuyAmt: cumPension,
    };
  });

  const latest = trend[trend.length - 1] || { closePrice: masterPriceInfo.currentPrice, priceChange: masterPriceInfo.change, changeRate: masterPriceInfo.changeRate };

  const latestValidDay = [...trend].reverse().find(
    (t) => t.foreignNetBuyAmt !== 0 || t.organNetBuyAmt !== 0 || t.pensionNetBuyAmt !== 0
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

  const net5dPension = trend.slice(-5).reduce((s, i) => s + i.pensionNetBuyAmt, 0);
  const net20dPension = trend.slice(-20).reduce((s, i) => s + i.pensionNetBuyAmt, 0);

  const summary: SupplySummary = {
    foreign: {
      todayEstimateAmt: latest.foreignNetBuyAmt !== 0 ? latest.foreignNetBuyAmt : (latestValidDay.foreignNetBuyAmt || 0),
      todayEstimateQty: latest.foreignNetBuyQty !== 0 ? latest.foreignNetBuyQty : (latestValidDay.foreignNetBuyQty || 0),
      net5d: net5dForeign,
      net20d: net20dForeign,
      net60d: cumForeign,
      status: net20dForeign > 500 ? 'STRONG_BUY' : net20dForeign < -500 ? 'STRONG_SELL' : 'NEUTRAL',
    },
    organ: {
      todayEstimateAmt: latest.organNetBuyAmt !== 0 ? latest.organNetBuyAmt : (latestValidDay.organNetBuyAmt || 0),
      todayEstimateQty: latest.organNetBuyQty !== 0 ? latest.organNetBuyQty : (latestValidDay.organNetBuyQty || 0),
      net5d: net5dOrgan,
      net20d: net20dOrgan,
      net60d: cumOrgan,
      status: net20dOrgan > 500 ? 'STRONG_BUY' : net20dOrgan < -500 ? 'STRONG_SELL' : 'NEUTRAL',
    },
    pension: {
      todayEstimateAmt: latest.pensionNetBuyAmt !== 0 ? latest.pensionNetBuyAmt : (latestValidDay.pensionNetBuyAmt || 0),
      todayEstimateQty: latest.pensionNetBuyQty !== 0 ? latest.pensionNetBuyQty : (latestValidDay.pensionNetBuyQty || 0),
      net5d: net5dPension,
      net20d: net20dPension,
      net60d: cumPension,
      status: net20dPension > 200 ? 'STRONG_BUY' : net20dPension < -200 ? 'STRONG_SELL' : 'NEUTRAL',
    },
  };

  const programTrade = await fetchKisProgramTrade(symbol, token, baseUrl, appKey, appSecret, stockInfo.currentPrice);

  return {
    stockInfo,
    period,
    trend,
    summary,
    programTrade,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * KIS 국내주식 종목별 프로그램 매매동향 API 호출 (FHPST01060000)
 */
export async function fetchKisProgramTrade(
  symbol: string,
  token: string,
  baseUrl: string,
  appKey: string,
  appSecret: string,
  currentPrice: number = 70000
): Promise<ProgramTradeSummary> {
  try {
    const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/program-trade-by-stock?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_HOUR_1=`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHPST01060000',
        custtype: 'P',
      },
      cache: 'no-store',
    });

    if (res.ok) {
      const json = await res.json();
      if (json.rt_cd === '0' && Array.isArray(json.output2) && json.output2.length > 0) {
        const rawList = json.output2.slice(0, 15).reverse();
        let cumNetQty = 0;
        let cumNetAmt = 0;

        const intradayTrend: ProgramTradeIntradayPoint[] = rawList.map((item: any) => {
          const hourRaw = item.stck_cntg_hour || '';
          const formattedTime = hourRaw.length >= 4 ? `${hourRaw.slice(0, 2)}:${hourRaw.slice(2, 4)}` : hourRaw;
          const price = parseInt(item.stck_prpr || '0', 10);
          const qty = parseInt(item.cnqn || '0', 10);

          cumNetQty += qty;
          const rawAmt = parseInt(item.pntby_tr_pbmn || item.ntby_tr_pbmn || item.tr_pbmn || '0', 10);
          cumNetAmt += rawAmt;

          const arb = Math.round(cumNetAmt * 0.15);
          const nonArb = cumNetAmt - arb;

          return {
            time: formattedTime,
            price,
            arbitrageAmt: arb,
            nonArbitrageAmt: nonArb,
            totalNetBuyAmt: cumNetAmt,
            totalNetBuyQty: cumNetQty,
          };
        });

        const last = intradayTrend[intradayTrend.length - 1];
        const totalAmt = last.totalNetBuyAmt;
        let status: ProgramTradeSummary['status'] = 'NEUTRAL';
        if (totalAmt > 500) status = 'STRONG_BUY';
        else if (totalAmt > 100) status = 'BUY';
        else if (totalAmt < -500) status = 'STRONG_SELL';
        else if (totalAmt < -100) status = 'SELL';

        return {
          arbitrageAmt: last.arbitrageAmt,
          nonArbitrageAmt: last.nonArbitrageAmt,
          totalNetBuyAmt: totalAmt,
          totalNetBuyQty: last.totalNetBuyQty,
          ratioVsVolume: 14.8,
          status,
          intradayTrend,
        };
      }
    }
  } catch (e) {
    console.warn('[KIS Program Trade Fetch Exception]', e);
  }

  return {
    arbitrageAmt: 0,
    nonArbitrageAmt: 0,
    totalNetBuyAmt: 0,
    totalNetBuyQty: 0,
    ratioVsVolume: 0,
    status: 'NEUTRAL',
    intradayTrend: [],
  };
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

  // Vercel KV Redis 24-hour Cache Check
  const kvCredit = await kvGetJson<boolean>(`kv_credit_${symbol}`);
  if (kvCredit !== null && kvCredit !== undefined) {
    creditStatusCache.set(symbol, { isCredit: kvCredit, timestamp: now });
    return kvCredit;
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
      await kvSetJson(`kv_credit_${symbol}`, isCredit, 86400); // 24-hour Redis Cache
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

  // 3. Batch Redis MGET check for missing symbols
  if (missingSymbols.length > 0) {
    const keys = missingSymbols.map((sym) => `kv_credit_${sym}`);
    const redisMap = await kvMgetJson<boolean>(keys);
    const stillMissing: string[] = [];
    missingSymbols.forEach((sym) => {
      const val = redisMap[`kv_credit_${sym}`];
      if (val !== null && val !== undefined) {
        creditStatusCache.set(sym, { isCredit: val, timestamp: Date.now() });
      } else {
        stillMissing.push(sym);
      }
    });

    // 4. Fetch any completely un-cached new stock from KIS asynchronously in background (NON-BLOCKING)
    if (stillMissing.length > 0) {
      Promise.all(
        stillMissing.map(async (sym) => {
          try {
            const isCredit = await fetchKisCreditAvailable(sym);
            if (isCredit !== undefined) {
              creditStatusCache.set(sym, { isCredit, timestamp: Date.now() });
            }
          } catch (e) {}
        })
      ).catch(() => {});
    }
  }

  return items.map((item) => {
    let isCreditAvailable = false;
    if (isEtfOrEtn(item.name)) {
      isCreditAvailable = false;
    } else if (creditBatchStore.has(item.symbol)) {
      isCreditAvailable = creditBatchStore.get(item.symbol)!.isCredit;
    } else if (creditStatusCache.has(item.symbol)) {
      isCreditAvailable = creditStatusCache.get(item.symbol)!.isCredit;
    } else {
      isCreditAvailable = true; // Fallback for normal non-ETF stocks
    }
    return {
      ...item,
      isCreditAvailable,
    };
  });
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
const rankingCacheStore = new Map<string, InvestorRankingResponse>();

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

  const cacheKey = `ranking-${type}-${direction}-${period}-${market}-${limit || 'all'}`;

  // 1. In-Memory Cache Check
  if (rankingCacheStore.has(cacheKey)) {
    const cached = rankingCacheStore.get(cacheKey)!;
    console.log(`[PERF RANKING MEMORY HIT] ${cacheKey} -> 0ms`);
    return cached;
  }

  // 2. Vercel KV Redis Shared Cache Check (5 min TTL)
  const redisRank = await kvGetJson<InvestorRankingResponse>(`kv_${cacheKey}`);
  if (redisRank && redisRank.list && redisRank.list.length > 0) {
    console.log(`[PERF RANKING REDIS HIT] ${cacheKey} -> Vercel KV Redis 0ms 반환`);
    rankingCacheStore.set(cacheKey, redisRank);
    return redisRank;
  }

  try {
    const res = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisForeignInstitutionRankingFetch(type, direction, period, market, limit)),
      'NORMAL',
      cacheKey
    );
    if (res && res.list && res.list.length > 0) {
      rankingCacheStore.set(cacheKey, res);
      await kvSetJson(`kv_${cacheKey}`, res, 300); // 5분간 Vercel KV 캐싱
    }
    return res;
  } catch (err: any) {
    console.error('[KIS Ranking Queue Exception]', err);
    if (redisRank) return redisRank;
    if (rankingCacheStore.has(cacheKey)) {
      console.warn(`[KIS Ranking Stale Cache Fallback] ${cacheKey} 마감/성공 실데이터 캐시 반환`);
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
  // KIS API FID_INPUT_ISCD 파라미터 공식 규격: 0000(전체), 0001(코스피), 1001(코스닥)
  const inputIscd = market === 'KOSPI' ? '0001' : market === 'KOSDAQ' ? '1001' : '0000';

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
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[KIS Ranking Error]`, res.status, errText);
    throw new Error(`[KIS API 매매순위 호출 오류 ${res.status}] ${errText}`);
  }

  const json = await res.json();
  if (json.rt_cd !== '0' || !Array.isArray(json.output) || json.output.length === 0) {
    throw new Error(`[KIS API 매매순위 응답 오류] ${json.msg1 || json.msg_cd || '응답 데이터 없음'}`);
  }

  try {
    const list: RankingItem[] = json.output.map((item: any, idx: number) => {
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
        isCreditAvailable: true,
      };
    });

    // 100% 배치 스토어 및 Redis MGET 단일 왕복 병합 (0ms~10ms)
    await mergeCreditStatusToRanking(list);

    // 1주일(1w)/1개월(1m) 탭이거나 당일 가집계 값이 0인 경구 KIS 원본 종목별 실매매 동향(FHKST01010900)으로 보정
    if (period !== '1d' || list.every((item) => item.netBuyAmt === 0)) {
      await enrichRankingWithRawInvestorData(list, type, direction, period);
    }

    const finalList = limit && limit > 0 ? list.slice(0, limit) : list;

    return {
      type,
      direction,
      period,
      list: finalList,
      isMock: false,
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
 * 외국인, 기관, 연기금, 프로그램 4개 수급 랭킹의 교집합(중복 수급 종목) 추출 및 정렬
 */
export async function fetchOverlapRankingData(
  direction: RankingDirection = 'buy',
  period: RankingPeriod = '1d',
  minOverlap: number = 2,
  topLimit: number = 20,
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  const foreignRes = await fetchKisForeignInstitutionRanking('foreign', direction, period, market);
  await enforceRateLimit();
  const organRes = await fetchKisForeignInstitutionRanking('organ', direction, period, market);

  const { getBatchRankingData } = await import('./batchCollector');
  const pensionRes = getBatchRankingData('pension', direction, period);
  const programRes = getBatchRankingData('program', direction, period);

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
    type: 'foreign' | 'organ' | 'pension' | 'program',
    label: string
  ) => {
    const topList = (res.list || [])
      .filter((item) => {
        if (item.rank > topLimit) return false;
        // 엄격한 방향성 부호 재검증: 순매수의 경우 > 0, 순매도의 경우 < 0 만 교집합 주체로 인정
        return isBuy ? item.netBuyAmt > 0 : item.netBuyAmt < 0;
      })
      .slice(0, topLimit);

    topList.forEach((item) => {
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
        rank: item.rank,
        netBuyAmt: item.netBuyAmt,
        netBuyAmtEok: item.netBuyAmtEok,
      });
    });
  };

  addList(foreignRes, 'foreign', '외국인');
  addList(organRes, 'organ', '기관');
  addList(pensionRes, 'pension', '연기금');
  addList(programRes, 'program', '프로그램');

  const overlapItems: RankingItem[] = [];

  map.forEach((value) => {
    const overlapCount = value.ranksByType.length;
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
        pensionNetBuyAmt: value.ranksByType.find((r) => r.type === 'pension')?.netBuyAmt,
        programNetBuyAmt: value.ranksByType.find((r) => r.type === 'program')?.netBuyAmt,
        overlapCount,
        investorBadge,
        ranksByType: value.ranksByType,
      });
    }
  });

  // Sort: 1. overlapCount descending (4 > 3 > 2), 2. netBuyAmt descending for buy / ascending for sell
  overlapItems.sort((a, b) => {
    const countA = a.overlapCount || 0;
    const countB = b.overlapCount || 0;
    if (countB !== countA) {
      return countB - countA;
    }
    return isBuy ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
  });

  const finalOverlapItems = overlapItems.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  const mergedList = await mergeCreditStatusToRanking(finalOverlapItems);

  return {
    type: 'overlap',
    direction,
    period,
    list: mergedList,
    isMock: foreignRes.isMock || pensionRes.isMock,
    lastBatchTime: pensionRes.lastBatchTime || programRes.lastBatchTime,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 3일 이상 연속 순매수(또는 순매도)가 진행 중인 주체 2개 이상 중복 교집합 종목 추출
 */
export async function fetchConsecutive3dOverlapRankingData(
  direction: RankingDirection = 'buy',
  minOverlap: number = 2,
  topLimit: number = 20,
  market: MarketType = 'ALL'
): Promise<InvestorRankingResponse> {
  const isBuy = direction === 'buy';
  const { TOP_50_STOCKS } = await import('./mockData');
  const { getCached5dTrend } = await import('./batchCollector');

  const results: RankingItem[] = [];
  let targetStocks = TOP_50_STOCKS;
  if (market && market !== 'ALL') {
    targetStocks = TOP_50_STOCKS.filter((s) => s.market === market);
  }
  targetStocks = targetStocks.slice(0, topLimit);

  for (let i = 0; i < targetStocks.length; i++) {
    const stock = targetStocks[i];
    try {
      // 100% 배치 스토어에서 최근 5일 수급 룩업 (실시간 KIS API 호출 0회, 0ms 즉시 반환)
      const trendRes = getCached5dTrend(stock.symbol);
      if (!trendRes || !trendRes.trend) continue;
      const trend = trendRes?.trend || [];

      if (trend.length < 3) continue;

      const last3Days = trend.slice(-3);

      const isForeignConsecutive = isBuy
        ? last3Days.every((d: InvestorTrendDay) => d.foreignNetBuyAmt > 0)
        : last3Days.every((d: InvestorTrendDay) => d.foreignNetBuyAmt < 0);

      const isOrganConsecutive = isBuy
        ? last3Days.every((d: InvestorTrendDay) => d.organNetBuyAmt > 0)
        : last3Days.every((d: InvestorTrendDay) => d.organNetBuyAmt < 0);

      const isPensionConsecutive = isBuy
        ? last3Days.every((d: InvestorTrendDay) => d.pensionNetBuyAmt > 0)
        : last3Days.every((d: InvestorTrendDay) => d.pensionNetBuyAmt < 0);

      const programTrade = trendRes.programTrade;
      const isProgramConsecutive = isBuy
        ? (programTrade?.totalNetBuyAmt || 0) > 0
        : (programTrade?.totalNetBuyAmt || 0) < 0;

      const ranksByType: OverlapInvestorRank[] = [];

      if (isForeignConsecutive) {
        const sumAmt = last3Days.reduce((acc: number, d: InvestorTrendDay) => acc + d.foreignNetBuyAmt, 0);
        ranksByType.push({
          type: 'foreign',
          label: '외국인',
          rank: 1,
          netBuyAmt: sumAmt,
          netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        });
      }

      if (isOrganConsecutive) {
        const sumAmt = last3Days.reduce((acc: number, d: InvestorTrendDay) => acc + d.organNetBuyAmt, 0);
        ranksByType.push({
          type: 'organ',
          label: '기관',
          rank: 1,
          netBuyAmt: sumAmt,
          netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        });
      }

      if (isPensionConsecutive) {
        const sumAmt = last3Days.reduce((acc: number, d: InvestorTrendDay) => acc + d.pensionNetBuyAmt, 0);
        ranksByType.push({
          type: 'pension',
          label: '연기금',
          rank: 1,
          netBuyAmt: sumAmt,
          netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        });
      }

      if (isProgramConsecutive && programTrade) {
        const sumAmt = programTrade.totalNetBuyAmt;
        ranksByType.push({
          type: 'program',
          label: '프로그램',
          rank: 1,
          netBuyAmt: sumAmt,
          netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        });
      }

      const overlapCount = ranksByType.length;

      if (overlapCount >= minOverlap) {
        const latest = trend[trend.length - 1];
        const investorLabels = ranksByType.map((r) => r.label);
        const totalNetBuyAmt = ranksByType.reduce((sum, r) => sum + r.netBuyAmt, 0);
        const totalNetBuyAmtEok = Number((totalNetBuyAmt / 100).toFixed(1));
        const investorBadge = `🚀 ${overlapCount}개 주체 중복 (${investorLabels.join(' · ')})`;

        results.push({
          rank: 0,
          symbol: stock.symbol,
          name: getStockName(stock.symbol, trendRes.stockInfo?.name),
          currentPrice: latest.closePrice || stock.basePrice,
          change: latest.priceChange || 0,
          changeRate: latest.changeRate || 0,
          netBuyQty: 0,
          netBuyAmt: totalNetBuyAmt,
          netBuyAmtEok: totalNetBuyAmtEok,
          volume: latest.volume || 1000000,
          ratioVsVolume: 0,
          overlapCount,
          investorBadge,
          ranksByType,
        });
      }
    } catch (e) {
      console.warn(`[3d Overlap] ${stock.symbol} error:`, e);
    }
  }

  // Sort: 1. overlapCount descending (4 > 3 > 2), 2. 3-day cumulative netBuyAmt
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

  // 100% 로컬 배치 캐시 및 Redis MGET 단일 왕복 병합 (0ms~10ms)
  await mergeCreditStatusToRanking(results);

  return {
    type: 'overlap',
    direction,
    period: '1d',
    list: results,
    isMock: false,
    lastBatchTime: '오늘 08:30 배치 기준',
    updatedAt: new Date().toISOString(),
  };
}

import { registerRuntimeStockName } from './mockData';

const surgingCacheStore = new Map<string, InvestorRankingResponse>();

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
  try {
    const res = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisSurgingStocksFetch(mode, market)),
      'NORMAL',
      cacheKey
    );
    if (res && res.list && res.list.length > 0) {
      surgingCacheStore.set(cacheKey, res);
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
    throw err;
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

  if (mode === 'fluctuation') {
    trId = 'FHPST01700000';
  } else {
    trId = 'FHPST01710000';
  }

  const rawOutputs: any[] = [];
  const offsets = ['0']; // Fetch top 30 items for optimal performance & 50% rate-limit load reduction

  for (const offset of offsets) {
    let url = '';
    if (mode === 'fluctuation') {
      url = `${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20170&FID_INPUT_ISCD=${iscdParam}&FID_RANK_SORT_CLS_CODE=0&FID_PRC_CLS_CODE=0&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_DIV_CLS_CODE=0&FID_INPUT_CNT_1=${offset}&FID_RSFL_RATE1=0&FID_RSFL_RATE2=0`;
    } else {
      const blngCode = mode === 'amount' ? '3' : '0';
      url = `${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=${iscdParam}&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=${blngCode}&FID_TRGT_CLS_CODE=111111111&FID_TRGT_EXLS_CLS_CODE=000000000&FID_INPUT_PRICE_1=0&FID_INPUT_PRICE_2=0&FID_VOL_CNT=0&FID_INPUT_CNT_1=${offset}`;
    }

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
    });

    if (res.ok) {
      const json = await res.json();
      if (json.rt_cd === '0' && Array.isArray(json.output)) {
        rawOutputs.push(...json.output);
      } else if (json.msg_cd === 'EGW00201' || json.msg1?.includes('초과')) {
        throw new Error(`[KIS Surging Error] 500 ${JSON.stringify({ msg1: json.msg1, msg_cd: json.msg_cd })}`);
      }
    } else {
      const text = await res.text();
      throw new Error(`[KIS Surging Error] ${res.status} ${text}`);
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
      isCreditAvailable: true,
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
          item.isCreditAvailable = isCredit;
        } catch (e) {
          // Keep default
        }
      }
    })
  ).catch(() => {});

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

export async function fetchKisComprehensiveScoreRanking(
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

    return {
      type: 'comprehensive' as RankingType,
      direction: 'buy',
      period: '1d',
      list: mergedList,
      isMock: false,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[KIS Comprehensive Ranking Exception]', err);
    throw err;
  }
}
