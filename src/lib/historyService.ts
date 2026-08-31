import fs from 'fs';
import path from 'path';
import {
  RankingItem,
  InvestorRankingResponse,
  RankingType,
  RankingDirection,
  RankingPeriod,
  MarketType,
  ScoreBreakdown,
} from './types';
import { TOP_300_STOCKS } from './stockUniverse300';
import { getSupabaseAdmin, getSupabasePublic, RawDailyInvestorRecord } from './supabase';
import { resolveMarketType, resolveStockPriceAndChange } from './mockData';

// ============================================================================
// 🛡️ [안전장치 1] 계산 로직 버전 관리 및 영구 저장 보류 스위치
// ============================================================================
export const CURRENT_CALC_LOGIC_VERSION = 'v1.1.0-synced-20260831';

/**
 * 🚨 [안전장치 2] 당일 교집합 뱃지 로직 최종 확정 전까지
 * 계산 결과(b)의 영구 디스크/DB 저장을 보류하고 항상 원본(a)로부터 재계산하도록 강제
 */
export const ALLOW_PERMANENT_CALC_STORAGE = false;

const HISTORY_CACHE_DIR = path.join(process.cwd(), 'scratch', 'history_cache');

export interface HistoryQueryParams {
  date: string; // '2026-08-28' or '20260828'
  type: RankingType;
  direction?: RankingDirection;
  period?: RankingPeriod;
  market?: MarketType;
  limit?: number;
  mode?: 'daily' | 'consecutive2d' | 'consecutive3d';
  surgingMode?: 'fluctuation' | 'volume' | 'amount' | 'comprehensive';
  forceRecalculate?: boolean; // 버전 변경 또는 강제 재계산 플래그
}

/**
 * ============================================================================
 * [Layer B] 계산된 랭킹/뱃지 파생 결과 계층 (로직 버전에 의존하는 파생 데이터)
 * ============================================================================
 */
export interface CalculatedHistoryCache {
  calcLogicVersion: string; // 예: "v1.0.0-draft"
  targetDate: string;
  calculatedAt: string;
  isFinalized: boolean; // 로직 최종 확정 여부
  data: InvestorRankingResponse;
}

function normalizeDate(rawDate: string): string {
  const cleaned = rawDate.replace(/[^0-9]/g, '');
  if (cleaned.length === 8) return cleaned;
  return '20260828'; // 기본 fallback 날짜
}

function formatDateLabel(dateStr: string): string {
  if (dateStr.length === 8) {
    const m = parseInt(dateStr.slice(4, 6), 10);
    const d = parseInt(dateStr.slice(6, 8), 10);
    return `(${m}/${d} 기준)`;
  }
  return '(확정 데이터)';
}

// ============================================================================
// [Layer A] 원본 수급 데이터 계층 (계산 로직과 무관한 KIS 영구 불변 팩트 데이터)
// ============================================================================

/**
 * 1. 특정 일자의 raw_daily_data 원본 팩트 데이터 로드 (로컬 디스크 파일 또는 Supabase DB 조회)
 */
export async function loadRawDailyRecordsForDate(targetDate: string): Promise<RawDailyInvestorRecord[]> {
  const normalized = normalizeDate(targetDate);

  // 1-1. 로컬 디스크 원본 파일 우선 확인 (scratch/raw_daily_data/{YYYYMMDD}.json)
  const localFilePath = path.join(process.cwd(), 'scratch', 'raw_daily_data', `${normalized}.json`);
  if (fs.existsSync(localFilePath)) {
    try {
      const content = fs.readFileSync(localFilePath, 'utf8');
      const records = JSON.parse(content);
      if (Array.isArray(records) && records.length > 0) {
        return records;
      }
    } catch (e) {
      console.warn('[History Layer A] 로컬 원본 파일 로드 실패, DB 조회 시도:', e);
    }
  }

  // 1-2. Supabase DB 조회
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (client) {
    try {
      const { data, error } = await client
        .from('raw_daily_data')
        .select('*')
        .eq('date', normalized);

      if (!error && data && data.length > 0) {
        // 로컬 디스크에 영구 불변 원본 동시 적재
        try {
          const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(localFilePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (_) {}
        return data as RawDailyInvestorRecord[];
      }
    } catch (e) {
      console.warn('[History Layer A] Supabase 원본 조회 실패:', e);
    }
  }

  return [];
}

// ============================================================================
// [Layer B 연산 및 재계산 경로]
// ============================================================================

/**
 * 2. 원본(Layer A) 데이터를 기반으로 랭킹/뱃지 연산 수행 (순수 함수)
 */
export function calculateRankingsFromRawRecords(
  rawRecords: RawDailyInvestorRecord[],
  params: HistoryQueryParams,
  normalizedDate: string
): InvestorRankingResponse {
  const dateLabel = formatDateLabel(normalizedDate);
  const market = params.market || 'ALL';
  const direction = params.direction || 'buy';
  const limit = params.limit || 50;

  // 시장 필터링
  const filtered = rawRecords.filter((r) => {
    if (market === 'ALL') return true;
    const resolved = resolveMarketType(r.symbol);
    return resolved === market;
  });

  let resultList: RankingItem[] = [];

  switch (params.type) {
    case 'foreign': {
      const sorted = [...filtered].sort((a, b) =>
        direction === 'buy' ? b.foreign_net_buy_amt - a.foreign_net_buy_amt : a.foreign_net_buy_amt - b.foreign_net_buy_amt
      );
      resultList = sorted.slice(0, limit).map((r, idx) => ({
        rank: idx + 1,
        symbol: r.symbol,
        name: r.name,
        market: resolveMarketType(r.symbol),
        currentPrice: r.close_price,
        change: 0,
        changeRate: r.change_rate || 0,
        volume: r.volume,
        ratioVsVolume: r.volume > 0 ? Number(((Math.abs(r.foreign_net_buy_qty) / r.volume) * 100).toFixed(1)) : 0,
        netBuyAmt: r.foreign_net_buy_amt,
        netBuyQty: r.foreign_net_buy_qty,
        netBuyAmtEok: Number((r.foreign_net_buy_amt / 100).toFixed(1)),
        asOfDateLabel: dateLabel,
      }));
      break;
    }
    case 'organ': {
      const sorted = [...filtered].sort((a, b) =>
        direction === 'buy' ? b.organ_net_buy_amt - a.organ_net_buy_amt : a.organ_net_buy_amt - b.organ_net_buy_amt
      );
      resultList = sorted.slice(0, limit).map((r, idx) => ({
        rank: idx + 1,
        symbol: r.symbol,
        name: r.name,
        market: resolveMarketType(r.symbol),
        currentPrice: r.close_price,
        change: 0,
        changeRate: r.change_rate || 0,
        volume: r.volume,
        ratioVsVolume: r.volume > 0 ? Number(((Math.abs(r.organ_net_buy_qty) / r.volume) * 100).toFixed(1)) : 0,
        netBuyAmt: r.organ_net_buy_amt,
        netBuyQty: r.organ_net_buy_qty,
        netBuyAmtEok: Number((r.organ_net_buy_amt / 100).toFixed(1)),
        asOfDateLabel: dateLabel,
      }));
      break;
    }
    case 'program': {
      const sorted = [...filtered].sort((a, b) =>
        direction === 'buy' ? (b.program_net_buy_amt || 0) - (a.program_net_buy_amt || 0) : (a.program_net_buy_amt || 0) - (b.program_net_buy_amt || 0)
      );
      resultList = sorted.slice(0, limit).map((r, idx) => ({
        rank: idx + 1,
        symbol: r.symbol,
        name: r.name,
        market: resolveMarketType(r.symbol),
        currentPrice: r.close_price,
        change: 0,
        changeRate: r.change_rate || 0,
        volume: r.volume,
        ratioVsVolume: r.volume > 0 ? Number(((Math.abs(r.program_net_buy_qty || 0) / r.volume) * 100).toFixed(1)) : 0,
        netBuyAmt: r.program_net_buy_amt || 0,
        netBuyQty: r.program_net_buy_qty || 0,
        netBuyAmtEok: Number(((r.program_net_buy_amt || 0) / 100).toFixed(1)),
        asOfDateLabel: dateLabel,
      }));
      break;
    }
    case 'overlap': {
      // 수급 교집합 (3대 주체 중 2개 이상 순매수한 종목)
      const overlapCandidates = filtered.map((r) => {
        const ranksByType: any[] = [];
        if (r.foreign_net_buy_amt > 0) {
          ranksByType.push({ type: 'foreign' as const, label: '외국인', rank: 0, netBuyAmt: r.foreign_net_buy_amt, netBuyAmtEok: Number((r.foreign_net_buy_amt / 100).toFixed(1)), asOfDateLabel: dateLabel });
        }
        if (r.organ_net_buy_amt > 0) {
          ranksByType.push({ type: 'organ' as const, label: '기관', rank: 0, netBuyAmt: r.organ_net_buy_amt, netBuyAmtEok: Number((r.organ_net_buy_amt / 100).toFixed(1)), asOfDateLabel: dateLabel });
        }
        if ((r.program_net_buy_amt || 0) > 0) {
          ranksByType.push({ type: 'program' as const, label: '프로그램', rank: 0, netBuyAmt: r.program_net_buy_amt || 0, netBuyAmtEok: Number(((r.program_net_buy_amt || 0) / 100).toFixed(1)), asOfDateLabel: dateLabel });
        }

        const ALL_ENTITIES: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }> = [
          { type: 'foreign', label: '외국인' },
          { type: 'organ', label: '기관' },
          { type: 'program', label: '프로그램' },
        ];
        const missingEntities = ALL_ENTITIES.filter((e) => !ranksByType.some((x) => x.type === e.type));
        const totalNetBuyAmt = ranksByType.reduce((sum, x) => sum + x.netBuyAmt, 0);

        return {
          rank: 0,
          symbol: r.symbol,
          name: r.name,
          market: resolveMarketType(r.symbol),
          currentPrice: r.close_price,
          change: 0,
          changeRate: r.change_rate || 0,
          volume: r.volume,
          ratioVsVolume: 0,
          netBuyQty: 0,
          netBuyAmt: totalNetBuyAmt,
          netBuyAmtEok: Number((totalNetBuyAmt / 100).toFixed(1)),
          overlapCount: ranksByType.length,
          ranksByType,
          missingEntities,
          asOfDateLabel: dateLabel,
        };
      }).filter((item) => item.overlapCount >= 2);

      overlapCandidates.sort((a, b) => b.overlapCount - a.overlapCount || b.netBuyAmt - a.netBuyAmt);
      resultList = overlapCandidates.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));
      break;
    }
    case 'surging': {
      const mode = params.surgingMode || 'fluctuation';
      const sorted = [...filtered].sort((a, b) => {
        if (mode === 'amount') return (b.close_price * b.volume) - (a.close_price * a.volume);
        if (mode === 'volume') return b.volume - a.volume;
        return (b.change_rate || 0) - (a.change_rate || 0);
      });
      resultList = sorted.slice(0, limit).map((r, idx) => ({
        rank: idx + 1,
        symbol: r.symbol,
        name: r.name,
        market: resolveMarketType(r.symbol),
        currentPrice: r.close_price,
        change: 0,
        changeRate: r.change_rate || 0,
        volume: r.volume,
        ratioVsVolume: 0,
        netBuyQty: 0,
        netBuyAmt: 0,
        netBuyAmtEok: 0,
        amountEok: Number(((r.close_price * r.volume) / 100000000).toFixed(1)),
        asOfDateLabel: dateLabel,
      }));
      break;
    }
    case 'comprehensive': {
      const sorted = [...filtered].sort((a, b) => {
        const scoreA = (a.change_rate || 0) * 0.4 + ((a.close_price * a.volume) / 1000000000) * 0.4 + (a.foreign_net_buy_amt / 100) * 0.2;
        const scoreB = (b.change_rate || 0) * 0.4 + ((b.close_price * b.volume) / 1000000000) * 0.4 + (b.foreign_net_buy_amt / 100) * 0.2;
        return scoreB - scoreA;
      });
      resultList = sorted.slice(0, limit).map((r, idx) => ({
        rank: idx + 1,
        symbol: r.symbol,
        name: r.name,
        market: resolveMarketType(r.symbol),
        currentPrice: r.close_price,
        change: 0,
        changeRate: r.change_rate || 0,
        volume: r.volume,
        ratioVsVolume: 0,
        netBuyQty: 0,
        netBuyAmt: 0,
        netBuyAmtEok: 0,
        amountEok: Number(((r.close_price * r.volume) / 100000000).toFixed(1)),
        scoreBreakdown: {
          foreignScore: Number((r.foreign_net_buy_amt / 100).toFixed(1)),
          organScore: Number((r.organ_net_buy_amt / 100).toFixed(1)),
        } as ScoreBreakdown,
        asOfDateLabel: dateLabel,
      }));
      break;
    }
    default:
      resultList = [];
  }

  return {
    type: params.type,
    direction,
    period: params.period || '1d',
    list: resultList,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
  };
}

/**
 * 3. 랭킹 조회 및 버전 무효화 / 원본 재계산 관리 함수
 */
export async function getHistoryRankingData(params: HistoryQueryParams): Promise<InvestorRankingResponse> {
  const normalizedDate = normalizeDate(params.date);
  const cacheKey = `${normalizedDate}_${params.type}_${params.direction || 'buy'}_${params.period || '1d'}_${params.market || 'ALL'}_${params.mode || 'daily'}_${params.surgingMode || 'fluctuation'}_${params.limit || 50}`;
  const cacheFile = path.join(HISTORY_CACHE_DIR, `${cacheKey}.json`);

  // 3-1. 영구 저장이 허용되어 있고 캐시가 존재하는 경우 버전 일치 여부 확인
  if (ALLOW_PERMANENT_CALC_STORAGE && !params.forceRecalculate && fs.existsSync(cacheFile)) {
    try {
      const cachedText = fs.readFileSync(cacheFile, 'utf8');
      const cacheEnvelope: CalculatedHistoryCache = JSON.parse(cachedText);

      // 버전이 동일하고 데이터가 유효하면 즉시 반환
      if (cacheEnvelope && cacheEnvelope.calcLogicVersion === CURRENT_CALC_LOGIC_VERSION && cacheEnvelope.data) {
        return cacheEnvelope.data;
      }
      console.log(`[History Layer B] 캐시 버전 불일치 (${cacheEnvelope?.calcLogicVersion} -> ${CURRENT_CALC_LOGIC_VERSION})로 인해 재계산 진행`);
    } catch (_) {}
  }

  // 3-2. 캐시 무효화 또는 영구 저장 보류 상태인 경우: 원본(Layer A)에서 즉시 재계산
  const rawRecords = await loadRawDailyRecordsForDate(normalizedDate);
  const calculatedResponse = calculateRankingsFromRawRecords(rawRecords, params, normalizedDate);

  // 3-3. 영구 저장 스위치가 켜진 경우에만 calcLogicVersion과 함께 디스크 저장
  if (ALLOW_PERMANENT_CALC_STORAGE) {
    try {
      if (!fs.existsSync(HISTORY_CACHE_DIR)) fs.mkdirSync(HISTORY_CACHE_DIR, { recursive: true });
      const envelope: CalculatedHistoryCache = {
        calcLogicVersion: CURRENT_CALC_LOGIC_VERSION,
        targetDate: normalizedDate,
        calculatedAt: new Date().toISOString(),
        isFinalized: true,
        data: calculatedResponse,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(envelope, null, 2), 'utf8');
    } catch (e) {
      console.warn('[History Layer B] 캐시 파일 저장 실패:', e);
    }
  }

  return calculatedResponse;
}

/**
 * 4. [재계산 경로] 특정 일자의 원본 데이터(Layer A)를 기반으로 전 탭 랭킹을 일괄 재계산
 */
export async function recalculateAllHistoryRankings(targetDate: string): Promise<{ success: boolean; count: number }> {
  const normalizedDate = normalizeDate(targetDate);
  const rawRecords = await loadRawDailyRecordsForDate(normalizedDate);

  if (!rawRecords || rawRecords.length === 0) {
    return { success: false, count: 0 };
  }

  const types: RankingType[] = ['foreign', 'organ', 'program', 'overlap', 'surging', 'comprehensive'];

  for (const type of types) {
    await getHistoryRankingData({
      date: normalizedDate,
      type,
      forceRecalculate: true,
    });
  }

  return { success: true, count: rawRecords.length };
}
