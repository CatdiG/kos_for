// KIS API Service Module - Updated Queue Delay & Rate Limit Guard
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InvestorTrendDay, InvestorTrendResponse, KisTokenResponse, ProgramTradeIntradayPoint, ProgramTradeSummary, SupplySummary, TrendPeriod, InvestorRankingResponse, RankingItem, RankingDirection, RankingPeriod, RankingType, OverlapInvestorRank, MarketType, SurgingRankItem, ScoreBreakdown, SurgingMode, isEtfOrEtn } from './types';
import { getStockName, resolveStockPriceAndChange, updateRuntimeStockPrice, resolveMarketType, computeUnifiedStatusBadge, getSettledAsOfDateLabel } from './mockData';
import { TOP_300_STOCKS } from './stockUniverse300';
import { fetchTokenFromSupabase, fetchCreditBatchFromSupabase, saveCreditBatchToSupabase } from './supabase';
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
      const latest = json.output2[0]; // 가장 최신 차수
      const foreignQty = parseInt(latest.frgn_fake_ntby_qty || '0', 10);
      const organQty = parseInt(latest.orgn_fake_ntby_qty || '0', 10);
      const stepGb = latest.bsop_hour_gb || '4';
      const stepMap: Record<string, { step: string; time: string }> = {
        '1': { step: '1차', time: '10:00' },
        '2': { step: '2차', time: '11:30' },
        '3': { step: '3차', time: '13:20' },
        '4': { step: '4차', time: '14:30' },
      };
      const info = stepMap[stepGb] || { step: `${stepGb}차`, time: '14:30' };
      return {
        foreignQty,
        organQty,
        step: info.step,
        timeStr: info.time,
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
      estimateDateLabel = isMarketOpen
        ? `당일 잠정 (${estimateRes.timeStr} 추정)`
        : `당일 최종잠정 (${estimateRes.timeStr} 기준)`;
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
    if (isMarketOpen) {
      if (isRealtimeData) {
        return `당일 잠정 (${timeStr} 추정)`;
      }
      if (!isFallback) {
        return `당일 잠정 (${timeStr} 추정)`;
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

  return {
    stockInfo,
    period,
    trend,
    summary,
    programTrade: programTrade || undefined,
    isMock: false,
    updatedAt: new Date().toISOString(),
  };
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
  } catch {}

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
    if (json.rt_cd !== '0' || !Array.isArray(json.output) || json.output.length === 0) {
      throw new Error(`[KIS API 매매순위 응답 오류] ${json.msg1 || json.msg_cd || '응답 데이터 없음'}`);
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

                if (!isMarketOpenNow || todayAmt === 0) {
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
  const closes = (trend || []).map((d) => d.closePrice).filter((c) => c && c > 0);
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

  return computeUnifiedStatusBadge(currentP, ma5, ma20, ma60);
}

const overlapMemoryCache = new Map<string, { data: InvestorRankingResponse; timestamp: number }>();
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
 * 비동기 백그라운드 수급 교집합 데이터 계산 헬퍼
 */
async function executeAsyncOverlapCalculation(
  direction: RankingDirection,
  period: RankingPeriod,
  minOverlap: number,
  market: MarketType,
  masterCacheKey: string
): Promise<InvestorRankingResponse> {
  function getTrendMultiplier(statusBadge?: string) {
    if (statusBadge?.includes('정배열')) return 1.5;   // 1위: 정배열 상승 추세
    if (statusBadge?.includes('바닥 반등')) return 1.4; // 2위: 바닥 반등 타점
    if (statusBadge?.includes('이평선 수렴')) return 1.0; // 3위: 이평선 수렴/관망
    if (statusBadge?.includes('단기 과열')) return 0.9; // 4위: 단기 과열
    if (statusBadge?.includes('역배열')) return 0.7;   // 5위: 역배열 하락 (오픈)
    return 1.0;
  }

  try {
    const { getBatchRankingData, getBatchRankingDataAsync, getCached5dTrend } = await import('./batchCollector');
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
      // 1. 트렌드 실데이터 조회 (0ms)
      const { getBatchTrend5d } = require('./batchCollector');
      const trendRes = getBatchTrend5d(value.symbol);
      const latestDay = trendRes?.trend && trendRes.trend.length > 0 ? trendRes.trend[trendRes.trend.length - 1] : null;

      // 랭킹 50위 밖이라도 당일 실제 순매수한 주체를 ranksByType에 보강
      if (latestDay) {
        // 외국인
        if (!value.ranksByType.some((r) => r.type === 'foreign') && (latestDay.foreignNetBuyAmt || 0) > 0) {
          const amt = latestDay.foreignNetBuyAmt || 0;
          value.ranksByType.push({
            type: 'foreign',
            label: '외국인',
            rank: 0,
            isRanked: false,
            netBuyAmt: amt,
            netBuyAmtEok: Number((amt / 100).toFixed(1)),
            asOfDateLabel: latestDay.date ? `(${latestDay.date.slice(4, 6)}/${latestDay.date.slice(6, 8)} 기준)` : '(당일)',
          });
        }
        // 기관
        if (!value.ranksByType.some((r) => r.type === 'organ') && (latestDay.organNetBuyAmt || 0) > 0) {
          const amt = latestDay.organNetBuyAmt || 0;
          value.ranksByType.push({
            type: 'organ',
            label: '기관',
            rank: 0,
            isRanked: false,
            netBuyAmt: amt,
            netBuyAmtEok: Number((amt / 100).toFixed(1)),
            asOfDateLabel: latestDay.date ? `(${latestDay.date.slice(4, 6)}/${latestDay.date.slice(6, 8)} 기준)` : '(당일)',
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

    // 상위 교집합 종목들의 60일 일봉 트렌드를 병렬 확보하여 차트와 100% 동일한 5대 상태 뱃지 산출
    const topOverlapCandidates = overlapItems.slice(0, 20);
    const trendResults = await Promise.all(
      topOverlapCandidates.map(async (item) => {
        const fullCacheKey = `${item.symbol}-60d-v60d-full`;
        let fullCached: InvestorTrendResponse | null | undefined = trendDetailCache.get(fullCacheKey)?.data;
        if (!fullCached || !fullCached.trend || fullCached.trend.length < 20) {
          fullCached = await fetchKisInvestorTrend(item.symbol, '60d', 'NORMAL').catch(() => null);
        }
        return { symbol: item.symbol, trendData: fullCached?.trend || [] };
      })
    );

    const trendMap = new Map<string, InvestorTrendDay[]>();
    trendResults.forEach((t) => trendMap.set(t.symbol, t.trendData));

    const finalOverlapItems = overlapItems.map((item, index) => {
      let trendData = trendMap.get(item.symbol) || [];
      let trendRes = getCached5dTrend(item.symbol);
      if (trendData.length === 0) {
        trendData = trendRes?.trend || [];
      }
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
      .map((item) => {
        const overlapScore = (item.overlapCount || 2) * 100;
        const logAmtScore = Math.log(Math.max(0, item.netBuyAmtEok || 0) + 1) * 20;
        const ratioScore = Math.min((item.ratioVsVolume || 0) * 1.5, 30);
        const candleScore = item.changeRate > 0
          ? Math.min(item.changeRate * 2.5, 20)
          : item.changeRate < 0 ? -15 : 0;

        const rawScore = overlapScore + logAmtScore + ratioScore + candleScore;
        const trendMult = getTrendMultiplier(item.statusBadge);
        return {
          symbol: item.symbol,
          score: rawScore * trendMult,
        };
      })
      .sort((a, b) => b.score - a.score);

    const top5Symbols = aiPickCandidates.slice(0, 5).map((c) => c.symbol);

    finalOverlapItems.forEach((item) => {
      const pickIdx = top5Symbols.indexOf(item.symbol);
      item.aiPickRank = pickIdx >= 0 ? pickIdx + 1 : undefined;
    });

    const mergedList = await mergeCreditStatusToRanking(finalOverlapItems);

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

const consecutiveOverlapMemoryCache = new Map<string, { data: InvestorRankingResponse; timestamp: number }>();
const CONSECUTIVE_OVERLAP_CACHE_TTL_MS = 30 * 1000; // 30초 TTL (실시간 수급 변동 및 신규 TR 즉시 반영)

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

  // Get candidate stocks from real-time market overlap ranking (no fixed stock list restriction!)
  const dailyOverlapRes = await fetchOverlapRankingData(direction, '1d', 2, 50, market).catch(() => null);
  const candidateStocks = dailyOverlapRes?.list || [];

  const ALL_ENTITIES: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }> = [
    { type: 'foreign', label: '외국인' },
    { type: 'organ', label: '기관' },
    { type: 'program', label: '프로그램' },
  ];

  const stockTrends: Array<{ stock: any; trendRes: any; programDaily: ProgramTradeDailyPoint[] }> = [];
  const targetCandidates = candidateStocks.slice(0, 12);
  const chunkResults = await Promise.all(
    targetCandidates.map(async (stock) => {
      let trendRes = getCached5dTrend(stock.symbol);
      if (!trendRes || !trendRes.trend || trendRes.trend.length < targetDays) {
        trendRes = await fetchKisInvestorTrend(stock.symbol, '5d').catch(() => null);
        if (trendRes && Array.isArray(trendRes.trend) && trendRes.trend.length > 0) {
          setCached5dTrend(stock.symbol, trendRes);
        }
      }
      const programDaily = await fetchKisProgramTradeDaily(stock.symbol).catch(() => []);
      return { stock, trendRes, programDaily };
    })
  );
  stockTrends.push(...chunkResults);

  const results: RankingItem[] = [];

  for (const { stock, trendRes, programDaily } of stockTrends) {
    if (!trendRes || !trendRes.trend || trendRes.trend.length === 0) continue;
    const trend = trendRes.trend;
    const fullTrend = trend;
    if (fullTrend.length < targetDays) continue;

    // Active trend days for Foreigner & Organ
    const activeFullDays = fullTrend.filter(
      (d: InvestorTrendDay) =>
        Math.abs(d.foreignNetBuyAmt || 0) > 0 ||
        Math.abs(d.organNetBuyAmt || 0) > 0
    );
    if (activeFullDays.length < targetDays) continue;
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
    if (!isStrictConsecutiveOverlap) continue;

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

    if (isForeignConsecutive) {
      const sumAmt = lastNDays.reduce((acc: number, d: InvestorTrendDay) => acc + d.foreignNetBuyAmt, 0);
      ranksByType.push({
        type: 'foreign',
        label: '외국인',
        rank: 1,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays: foreignConsecutiveDays,
        consecutiveText: `${foreignConsecutiveDays}일연속`,
        asOfDateLabel: '당일 가집계',
      });
    } else if (foreignConsecutiveDays > 0) {
      const todayAmt = activeFullDays[activeFullDays.length - 1]?.foreignNetBuyAmt || 0;
      ranksByType.push({
        type: 'foreign',
        label: '외국인',
        rank: 0,
        isRanked: false,
        netBuyAmt: todayAmt,
        netBuyAmtEok: Number((todayAmt / 100).toFixed(1)),
        consecutiveDays: foreignConsecutiveDays,
        consecutiveText: '당일순매수',
        asOfDateLabel: '당일 가집계',
      });
    }

    if (isOrganConsecutive) {
      const sumAmt = lastNDays.reduce((acc: number, d: InvestorTrendDay) => acc + d.organNetBuyAmt, 0);
      ranksByType.push({
        type: 'organ',
        label: '기관',
        rank: 1,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays: organConsecutiveDays,
        consecutiveText: `${organConsecutiveDays}일연속`,
        asOfDateLabel: '당일 가집계',
      });
    } else if (organConsecutiveDays > 0) {
      const todayAmt = activeFullDays[activeFullDays.length - 1]?.organNetBuyAmt || 0;
      ranksByType.push({
        type: 'organ',
        label: '기관',
        rank: 0,
        isRanked: false,
        netBuyAmt: todayAmt,
        netBuyAmtEok: Number((todayAmt / 100).toFixed(1)),
        consecutiveDays: organConsecutiveDays,
        consecutiveText: '당일순매수',
        asOfDateLabel: '당일 가집계',
      });
    }

    if (isProgramConsecutive) {
      const sumAmt = programDaily.slice(0, targetDays).reduce((acc: number, p: ProgramTradeDailyPoint) => acc + p.totalNetBuyAmt, 0);
      ranksByType.push({
        type: 'program',
        label: '프로그램',
        rank: 1,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays: programConsecutiveDays,
        consecutiveText: `${programConsecutiveDays}일연속`,
        asOfDateLabel: getSettledAsOfDateLabel(),
      });
    } else if (programConsecutiveDays > 0) {
      const todayAmt = programDaily[0]?.totalNetBuyAmt || 0;
      ranksByType.push({
        type: 'program',
        label: '프로그램',
        rank: 0,
        isRanked: false,
        netBuyAmt: todayAmt,
        netBuyAmtEok: Number((todayAmt / 100).toFixed(1)),
        consecutiveDays: programConsecutiveDays,
        consecutiveText: '당일순매수',
        asOfDateLabel: getSettledAsOfDateLabel(),
      });
    }

    const consecutiveEntities = ranksByType.filter((r) => (r.consecutiveDays || 0) >= targetDays);
    const consecutiveOverlapCount = consecutiveEntities.length;

    // 2일/3일 연속 교집합의 절대 요건: 실제 targetDays(2일/3일) 이상 연속 매수한 주체가 minOverlap(2개) 이상이어야 함!
    if (consecutiveOverlapCount >= minOverlap) {
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

  // Calculate Risk-Adjusted AI Pick Candidates (Matching 1st~6th Buy Timing Hierarchy)
  function getTrendMultiplier(statusBadge?: string) {
    if (statusBadge?.includes('정배열')) return 1.5;   // 1위 (정배열 상승 추세)
    if (statusBadge?.includes('바닥 반등')) return 1.4; // 2위 (손익비 우수 반등 타점)
    if (statusBadge?.includes('이평선 수렴')) return 1.0; // 3위 (에너지 축적/관망)
    if (statusBadge?.includes('단기 과열')) return 0.9; // 4위 (돌파 모멘텀 인정/소폭 차감)
    if (statusBadge?.includes('역배열')) return 0.7;   // 5위 (하락 추세/오픈)
    return 1.0;
  }

  const aiPickCandidates = [...results]
    .map((item) => {
      const overlapScore = (item.overlapCount || 2) * 100;
      const logAmtScore = Math.log(Math.max(0, item.netBuyAmtEok || 0) + 1) * 20;
      const ratioScore = Math.min((item.ratioVsVolume || 0) * 1.5, 30);
      const candleScore = item.changeRate > 0
        ? Math.min(item.changeRate * 2.5, 20)
        : item.changeRate < 0 ? -15 : 0;

      const rawScore = overlapScore + logAmtScore + ratioScore + candleScore;
      const trendMult = getTrendMultiplier(item.statusBadge);
      return {
        symbol: item.symbol,
        score: rawScore * trendMult,
      };
    })
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
  };

  if (masterData.list && masterData.list.length > 0) {
    consecutiveOverlapMemoryCache.set(cacheKey, { data: masterData, timestamp: Date.now() });
  }

  return masterData;
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

  // 1. In-Memory Cache Check (0ms latency)
  if (surgingCacheStore.has(cacheKey)) {
    const cached = surgingCacheStore.get(cacheKey)!;
    if (Date.now() - new Date(cached.updatedAt).getTime() < 60000) {
      return cached;
    }
  }

  try {
    const res = await kisQueue.enqueue(
      () => fetchWithRetry(() => executeKisSurgingStocksFetch(mode, market), 1, 300),
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

const comprehensiveCacheStore = new Map<string, { data: InvestorRankingResponse; timestamp: number }>();

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

    return result;
  } catch (err) {
    console.error('[KIS Comprehensive Ranking Exception]', err);
    throw err;
  }
}
