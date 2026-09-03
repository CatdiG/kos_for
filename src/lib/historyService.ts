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
  OverlapInvestorRank,
  isEtfOrEtn,
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
  surgingMode?: 'fluctuation' | 'volume' | 'amount' | 'comprehensive' | 'overlap';
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

export function normalizeDate(rawDate: string): string {
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
 * 1. 특정 일자의 raw_daily_data 원본 팩트 데이터 로드 (로컬 디스크 파일 + Supabase DB를 symbol 기준 병합)
 *
 * 🚨 [버그 수정] 예전엔 로컬 파일이 존재하고 비어있지만 않으면 무조건 그것만 신뢰하고 DB 조회를
 * 건너뛰었다. 그런데 vercel.json이 하루 수집을 2개 크론(0~148 / 148~295 종목 구간)으로 쪼개 호출하고,
 * 로컬 파일 저장이 매 회차마다 덮어쓰기였던 과거 버그(supabase.ts saveRawDailyDataToSupabase, 이번에
 * 같이 수정) 때문에 로컬 파일이 295건 중 147건만 남는 손상이 실제로 발생했었다(2026-09-02 실측).
 * DB는 date+symbol 기준 upsert라 항상 완전하므로, 이제는 로컬 파일과 DB를 symbol 기준으로 합집합
 * 병합하고(둘 중 어느 한쪽에만 있어도 살림 - 8/28처럼 DB에 아예 없고 로컬에만 있던 케이스도 보존),
 * DB가 더 완전하면 로컬 캐시도 병합 결과로 재저장해서 다음 조회부터는 자가 치유되도록 한다.
 */
export async function loadRawDailyRecordsForDate(targetDate: string): Promise<RawDailyInvestorRecord[]> {
  const normalized = normalizeDate(targetDate);
  const localFilePath = path.join(process.cwd(), 'scratch', 'raw_daily_data', `${normalized}.json`);

  // 1-1. 로컬 디스크 원본 파일 로드 시도
  let localRecords: RawDailyInvestorRecord[] = [];
  if (fs.existsSync(localFilePath)) {
    try {
      const content = fs.readFileSync(localFilePath, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) localRecords = parsed;
    } catch (e) {
      console.warn('[History Layer A] 로컬 원본 파일 로드 실패:', e);
    }
  }

  // 1-2. Supabase DB 조회
  let dbRecords: RawDailyInvestorRecord[] = [];
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (client) {
    try {
      const { data, error } = await client
        .from('raw_daily_data')
        .select('*')
        .eq('date', normalized);
      if (!error && Array.isArray(data)) dbRecords = data as RawDailyInvestorRecord[];
    } catch (e) {
      console.warn('[History Layer A] Supabase 원본 조회 실패:', e);
    }
  }

  // 1-3. symbol 기준 합집합 병합 (DB를 더 신뢰 - upsert로 항상 완전 축적되므로 로컬과 겹치면 DB 값 우선)
  const merged = new Map<string, RawDailyInvestorRecord>();
  localRecords.forEach((r) => { if (r?.symbol) merged.set(r.symbol, r); });
  dbRecords.forEach((r) => { if (r?.symbol) merged.set(r.symbol, r); });
  const mergedRecords = [...merged.values()];

  // 1-4. 병합 결과가 기존 로컬 파일보다 더 완전하면(=로컬이 손상돼 있었으면) 로컬 캐시를 자가 치유 재저장
  if (mergedRecords.length > localRecords.length) {
    try {
      const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(localFilePath, JSON.stringify(mergedRecords, null, 2), 'utf8');
      console.log(`[History Layer A] 로컬 캐시 자가 치유: ${normalized}.json (${localRecords.length}건 → ${mergedRecords.length}건)`);
    } catch (_) {}
  }

  return mergedRecords;
}

/**
 * 1-1. 로컬 디스크 + Supabase에 실제로 수집돼 있는 날짜 목록을 오름차순으로 반환한다.
 * (수급교집합 2일/3일연속처럼 여러 날짜를 이어서 봐야 하는 계산에 사용)
 */
export async function listAvailableRawDates(): Promise<string[]> {
  const dateSet = new Set<string>();

  // 로컬 디스크: scratch/raw_daily_data/{YYYYMMDD}.json 패턴만 (3m_* 3분봉 캐시 파일 제외)
  const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
  if (fs.existsSync(dir)) {
    try {
      fs.readdirSync(dir).forEach((f) => {
        const m = f.match(/^(\d{8})\.json$/);
        if (m) dateSet.add(m[1]);
      });
    } catch (e) {
      console.warn('[History Layer A] 로컬 날짜 목록 조회 실패:', e);
    }
  }

  // Supabase: distinct date (행이 많으므로 상위 2000건만 훑어 중복 제거)
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (client) {
    try {
      const { data, error } = await client.from('raw_daily_data').select('date').limit(2000);
      if (!error && data) {
        data.forEach((row: any) => row.date && dateSet.add(row.date));
      }
    } catch (e) {
      console.warn('[History Layer A] Supabase 날짜 목록 조회 실패:', e);
    }
  }

  return [...dateSet].sort();
}

/**
 * 1-2. 특정 종료일(endDate) 기준으로 실제 수집된 날짜 중 최근 N일치를 오름차순으로 로드한다.
 * (예: endDate=20260902, days=3 -> 8/31, 9/1, 9/2 순으로 반환. 수집된 날짜가 N일보다 적으면 있는 만큼만 반환)
 */
export async function loadRawRecordsForDateRange(
  normalizedEndDate: string,
  days: number
): Promise<Array<{ date: string; records: RawDailyInvestorRecord[] }>> {
  const availableDates = await listAvailableRawDates();
  const upToEnd = availableDates.filter((d) => d <= normalizedEndDate);
  const targetDates = upToEnd.slice(-days); // 최근 N개(오름차순 유지)

  const results: Array<{ date: string; records: RawDailyInvestorRecord[] }> = [];
  for (const d of targetDates) {
    const records = await loadRawDailyRecordsForDate(d);
    if (records.length > 0) results.push({ date: d, records });
  }
  return results;
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
      // 수급 교집합 (3대 주체 중 2개 이상 매수 - 매도 조회 시엔 2개 이상 매도한 종목)
      // 순위 상위 N위 제한은 걸지 않는다 - 수집된 전 종목(raw_daily_data) 중 실제로 순매수(또는 순매도)한
      // 주체가 2개 이상이면 전부 포함한다. 라이브 화면은 KIS의 "상위 50위 랭킹" API 자체에서 데이터를
      // 가져오는 구조라 태생적으로 50위 밖은 못 보는데, 이건 라이브 쪽의 한계지 교집합의 올바른 정의가
      // 아니다 - 히스토리는 원본 데이터를 다 갖고 있으니 굳이 그 한계를 따라할 필요가 없다.
      const passesDirection = (amt: number) => (direction === 'buy' ? amt > 0 : amt < 0);
      const overlapCandidates = filtered.map((r) => {
        const ranksByType: any[] = [];
        if (passesDirection(r.foreign_net_buy_amt)) {
          ranksByType.push({ type: 'foreign' as const, label: '외국인', rank: 0, netBuyAmt: r.foreign_net_buy_amt, netBuyAmtEok: Number((r.foreign_net_buy_amt / 100).toFixed(1)), asOfDateLabel: dateLabel });
        }
        if (passesDirection(r.organ_net_buy_amt)) {
          ranksByType.push({ type: 'organ' as const, label: '기관', rank: 0, netBuyAmt: r.organ_net_buy_amt, netBuyAmtEok: Number((r.organ_net_buy_amt / 100).toFixed(1)), asOfDateLabel: dateLabel });
        }
        if (passesDirection(r.program_net_buy_amt || 0)) {
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

      overlapCandidates.sort((a, b) => {
        if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
        return direction === 'buy' ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
      });
      resultList = overlapCandidates.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));
      break;
    }
    case 'surging': {
      const mode = params.surgingMode || 'fluctuation';

      if (mode === 'overlap') {
        // 급등주 교집합(3중): 등락률 3%+ 상위 종목이면서, 등락률·거래량·거래대금 중 2개 이상 지표에서
        // 상위 SURGE_TOP_N 안에 동시에 들어야 함 (라이브 앱 fetchKisSurgingOverlap과 동일한 기준)
        const SURGE_TOP_N = 60;
        const byFluc = [...filtered].filter((r) => (r.change_rate || 0) >= 3.0).sort((a, b) => (b.change_rate || 0) - (a.change_rate || 0)).slice(0, SURGE_TOP_N);
        const byVol = [...filtered].sort((a, b) => b.volume - a.volume).slice(0, SURGE_TOP_N);
        const byAmt = [...filtered].sort((a, b) => (b.close_price * b.volume) - (a.close_price * a.volume)).slice(0, SURGE_TOP_N);

        const flucRankMap = new Map(byFluc.map((r, idx) => [r.symbol, idx + 1]));
        const volRankMap = new Map(byVol.map((r, idx) => [r.symbol, idx + 1]));
        const amtRankMap = new Map(byAmt.map((r, idx) => [r.symbol, idx + 1]));

        const candidates = byFluc.filter((r) => flucRankMap.has(r.symbol)); // 등락 3%+ 게이트 통과 종목만 후보
        const withModes = candidates.map((r) => {
          const surgingRanks: Array<{ type: 'fluctuation' | 'volume' | 'amount'; label: string; rank: number }> = [];
          surgingRanks.push({ type: 'fluctuation', label: '등락률', rank: flucRankMap.get(r.symbol)! });
          if (volRankMap.has(r.symbol)) surgingRanks.push({ type: 'volume', label: '거래량', rank: volRankMap.get(r.symbol)! });
          if (amtRankMap.has(r.symbol)) surgingRanks.push({ type: 'amount', label: '거래대금', rank: amtRankMap.get(r.symbol)! });
          return { r, surgingRanks };
        }).filter((x) => x.surgingRanks.length >= 2);

        withModes.sort((a, b) => b.surgingRanks.length - a.surgingRanks.length || (b.r.change_rate || 0) - (a.r.change_rate || 0));

        resultList = withModes.slice(0, limit).map(({ r, surgingRanks }, idx) => ({
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
          surgingModes: surgingRanks.map((s) => s.type),
          surgingRanks,
          surgingBadge: surgingRanks.map((s) => `${s.label} ${s.rank}위`).join(' · '),
          asOfDateLabel: dateLabel,
        }));
        break;
      }

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
    // 'comprehensive'는 getHistoryRankingData에서 calculateComprehensiveFromHistory로 먼저 분기되므로
    // (거래량증가율 계산에 전일 원본이 추가로 필요해 단일 날짜 동기 함수인 여기서는 처리하지 않는다) 여기엔 없다.
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

// 주체별 "N일연속" 뱃지에 실제 연속일수를 캡핑 없이 보여주기 위한 최대 역추적 범위(약 1개월 영업일).
// 라이브 탭(kisApi.ts)은 KIS API에서 '5d' 트렌드만 받아와 backward loop를 돌리는 반면, 히스토리는
// raw_daily_data 원본을 이미 다 갖고 있으니 그 한계를 따라할 필요가 없다 - 더 넉넉하게 잡는다.
const CONSECUTIVE_BADGE_LOOKBACK_DAYS = 20;

/**
 * 2-1. 수급교집합 2일/3일연속 - 히스토리 원본에 실제로 쌓인 날짜들 중 targetDate로 끝나는 최근 영업일들을
 * 최대 CONSECUTIVE_BADGE_LOOKBACK_DAYS일치 이어붙여서, 라이브 앱과 동일한 2단계 판정을 수행한다:
 * (1) "일자별 엄격 검사" - 최근 targetDays 영업일은 매일 2개 이상 주체가 동시매수/동시매도해야 이 탭 후보.
 * (2) 주체별 실제 연속일수는 targetDays로 캡핑하지 않고, 데이터가 이어지는 한 계속 뒤로 거슬러 올라가며
 *     진짜 연속일수를 구한다(라이브 kisApi.ts의 backward consecutive days 계산과 동일한 방식) - 그래서
 *     "3일연속" 탭에서도 실제로 5일 연속 매수 중인 종목은 뱃지에 "5일연속"이라고 정확히 표시된다.
 * 수집된 날짜가 targetDays보다 적으면 계산 불가로 빈 목록을 반환한다.
 */
export async function calculateConsecutiveOverlapFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams,
  targetDays: 2 | 3
): Promise<InvestorRankingResponse> {
  const market = params.market || 'ALL';
  const direction = params.direction || 'buy';
  const limit = params.limit || 50;
  const dateLabel = formatDateLabel(normalizedDate);
  const minOverlap = 2;
  const passesDirection = (amt: number) => (direction === 'buy' ? amt > 0 : amt < 0);

  const dateGroups = await loadRawRecordsForDateRange(normalizedDate, CONSECUTIVE_BADGE_LOOKBACK_DAYS);

  if (dateGroups.length < targetDays || dateGroups[dateGroups.length - 1]?.date !== normalizedDate) {
    // 이 날짜를 기준으로 targetDays 만큼 이어지는 수집된 원본이 부족함 (예: 수집 시작일 근처)
    return {
      type: 'overlap',
      direction,
      period: `consecutive${targetDays}d` as any,
      list: [],
      isMock: false,
      updatedAt: new Date().toISOString(),
      lastBatchTime: dateLabel,
      error: `${normalizedDate} 기준 최근 ${targetDays}영업일치 원본 데이터가 아직 부족합니다 (수집 시작일 근처이거나 데이터 공백 구간).`,
    };
  }

  // symbol -> date -> record (최대 20영업일치 전체)
  const bySymbol = new Map<string, Map<string, RawDailyInvestorRecord>>();
  dateGroups.forEach(({ date, records }) => {
    records.forEach((r) => {
      if (market !== 'ALL' && resolveMarketType(r.symbol) !== market) return;
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Map());
      bySymbol.get(r.symbol)!.set(date, r);
    });
  });

  const orderedDates = dateGroups.map((g) => g.date); // 오름차순, 최대 20개
  const lastTargetDates = orderedDates.slice(-targetDays); // 이 탭의 "매일 2개 이상 동시매수" 판정 대상 구간
  const results: RankingItem[] = [];

  bySymbol.forEach((dateMap, symbol) => {
    // 최근 targetDays 영업일 전체에 데이터가 있어야 판정 가능
    if (!lastTargetDates.every((d) => dateMap.has(d))) return;

    const dayByDayCounts = lastTargetDates.map((d) => {
      const r = dateMap.get(d)!;
      let cnt = 0;
      if (passesDirection(r.foreign_net_buy_amt)) cnt++;
      if (passesDirection(r.organ_net_buy_amt)) cnt++;
      if (passesDirection(r.program_net_buy_amt || 0)) cnt++;
      return cnt;
    });

    const isStrictConsecutive = dayByDayCounts.every((c) => c >= minOverlap);
    if (!isStrictConsecutive) return;

    const latest = dateMap.get(normalizedDate)!;
    const ranksByType: OverlapInvestorRank[] = [];
    const ENTITY_DEFS: Array<{ type: 'foreign' | 'organ' | 'program'; label: string; amtKey: 'foreign_net_buy_amt' | 'organ_net_buy_amt' | 'program_net_buy_amt' }> = [
      { type: 'foreign', label: '외국인', amtKey: 'foreign_net_buy_amt' },
      { type: 'organ', label: '기관', amtKey: 'organ_net_buy_amt' },
      { type: 'program', label: '프로그램', amtKey: 'program_net_buy_amt' },
    ];

    ENTITY_DEFS.forEach(({ type, label, amtKey }) => {
      // 이 주체의 "진짜" 연속일수를 최신일부터 거슬러 올라가며 구한다 (targetDays로 캡핑하지 않음 -
      // 데이터 공백을 만나거나 방향 조건이 끊기는 지점까지 계속 센다).
      let consecutiveDays = 0;
      let sumAmt = 0;
      for (let i = orderedDates.length - 1; i >= 0; i--) {
        const r = dateMap.get(orderedDates[i]);
        if (!r) break; // 이 종목의 수집 기록 자체가 없는 날 = 보수적으로 연속 끊김 처리
        const amt = r[amtKey] || 0;
        if (!passesDirection(amt)) break;
        consecutiveDays++;
        sumAmt += amt;
      }
      if (consecutiveDays < targetDays) return; // 이 탭(targetDays)의 자격 미달 - 표시 안 함
      ranksByType.push({
        type,
        label,
        rank: 1,
        isRanked: true,
        netBuyAmt: sumAmt,
        netBuyAmtEok: Number((sumAmt / 100).toFixed(1)),
        consecutiveDays,
        consecutiveText: `${consecutiveDays}일연속`,
        asOfDateLabel: dateLabel,
      });
    });

    // "매일 2개 이상 주체가 동시매수"(day-by-day) 조건은 서로 다른 주체 조합으로도 통과할 수 있다
    // (예: 1일차엔 외국인+기관, 2일차엔 기관+프로그램이 매수해도 하루하루는 2개 이상이지만, 이틀 내내
    // 연속으로 산 주체는 기관 1개뿐). 진짜 "N일 연속 동시매수"가 되려면 대상 기간 내내 연속으로 매수한
    // 주체(ranksByType) 자체가 minOverlap(2)개 이상이어야 한다 - 라이브 앱의 consecutiveOverlapCount와
    // 동일한 최종 검증이며, 이게 빠져있어서 실제로는 주체 1개만 연속매수인 종목이 섞여 들어가고 있었다.
    if (ranksByType.length < minOverlap) return;

    // 2일연속 탭 전용 상위 등급(3일연속) 중복 제외: 실제 연속일수가 3일 이상인 주체가 minOverlap개 이상이면
    // "3일연속 교집합" 탭에만 노출되어야 하므로 여기서 걸러낸다(라이브 앱의 qualifiesForNextTier와 동일).
    const qualifiesForNextTier = targetDays === 2 && ranksByType.filter((r) => (r.consecutiveDays || 0) >= 3).length >= minOverlap;
    if (qualifiesForNextTier) return;

    const totalNetBuyAmt = ranksByType.reduce((sum, r) => sum + r.netBuyAmt, 0);
    const ALL_ENTITIES: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }> = [
      { type: 'foreign', label: '외국인' },
      { type: 'organ', label: '기관' },
      { type: 'program', label: '프로그램' },
    ];
    const missingEntities = ALL_ENTITIES.filter((e) => !ranksByType.some((r) => r.type === e.type));

    results.push({
      rank: 0,
      symbol,
      name: latest.name,
      market: resolveMarketType(symbol),
      currentPrice: latest.close_price,
      change: 0,
      changeRate: latest.change_rate || 0,
      volume: latest.volume,
      ratioVsVolume: 0,
      netBuyQty: 0,
      netBuyAmt: totalNetBuyAmt,
      netBuyAmtEok: Number((totalNetBuyAmt / 100).toFixed(1)),
      overlapCount: ranksByType.length,
      ranksByType,
      missingEntities,
      asOfDateLabel: dateLabel,
    });
  });

  results.sort((a, b) => {
    if ((b.overlapCount || 0) !== (a.overlapCount || 0)) return (b.overlapCount || 0) - (a.overlapCount || 0);
    return direction === 'buy' ? b.netBuyAmt - a.netBuyAmt : a.netBuyAmt - b.netBuyAmt;
  });

  const list = results.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));

  return {
    type: 'overlap',
    direction,
    period: `consecutive${targetDays}d` as any,
    list,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
  };
}

export interface HistoryDropoutItem {
  symbol: string;
  name: string;
  reason: string;
  currentPrice: number;
  changeRate: number;
  netBuyAmtEok: number;
  droppedFromDate: string; // 직전에 활성 상태였던 날짜
}

export interface HistoryDropoutResult {
  list: HistoryDropoutItem[];
  targetDays: 2 | 3;
  comparedDate: string | null; // 비교 기준이 된 직전 영업일 (없으면 null)
  note?: string;
}

/**
 * 2-1-1. 수급교집합 이탈 종목(히스토리판) - normalizedDate 바로 이전에 수집된 영업일에는
 * targetDays연속 조건을 만족했지만, normalizedDate에는 더 이상 만족하지 못하게 된 종목을 찾는다.
 * (라이브 앱의 "이탈 종목" 탭과 동일한 개념을 과거 날짜에 대해 재현)
 */
export async function calculateOverlapDropoutsFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams,
  targetDays: 2 | 3
): Promise<HistoryDropoutResult> {
  const availableDates = await listAvailableRawDates();
  const priorDates = availableDates.filter((d) => d < normalizedDate);
  const comparedDate = priorDates.length > 0 ? priorDates[priorDates.length - 1] : null;

  if (!comparedDate) {
    return { list: [], targetDays, comparedDate: null, note: '비교할 직전 영업일 원본 데이터가 아직 없습니다 (수집 시작일).' };
  }

  const [prevActive, todayActive] = await Promise.all([
    calculateConsecutiveOverlapFromHistory(comparedDate, params, targetDays),
    calculateConsecutiveOverlapFromHistory(normalizedDate, params, targetDays),
  ]);

  if (prevActive.error) {
    return { list: [], targetDays, comparedDate, note: `${comparedDate} 기준 비교 데이터 부족: ${prevActive.error}` };
  }

  const todaySymbols = new Set(todayActive.list.map((i) => i.symbol));
  const dropped = prevActive.list.filter((i) => !todaySymbols.has(i.symbol));

  if (dropped.length === 0) {
    return { list: [], targetDays, comparedDate, note: `${comparedDate} → ${normalizedDate} 사이 이탈한 종목이 없습니다.` };
  }

  // 오늘자 원본에서 현재가/등락률/이탈 사유 단서를 보강
  const todayRawMap = new Map((await loadRawDailyRecordsForDate(normalizedDate)).map((r) => [r.symbol, r]));

  const list: HistoryDropoutItem[] = dropped.map((item) => {
    const todayRaw = todayRawMap.get(item.symbol);
    let reason = '이탈';
    if (!todayRaw) {
      reason = '당일 데이터 없음';
    } else {
      const passesDirection = (amt: number) => ((params.direction || 'buy') === 'buy' ? amt > 0 : amt < 0);
      const broken: string[] = [];
      if (!passesDirection(todayRaw.foreign_net_buy_amt)) broken.push('외국인');
      if (!passesDirection(todayRaw.organ_net_buy_amt)) broken.push('기관');
      if (!passesDirection(todayRaw.program_net_buy_amt || 0)) broken.push('프로그램');
      reason = broken.length > 0 ? `${broken.join('·')} 동시매수 조건 이탈` : '동시매수 주체 수 부족';
    }
    return {
      symbol: item.symbol,
      name: item.name,
      reason,
      currentPrice: todayRaw?.close_price ?? item.currentPrice,
      changeRate: todayRaw?.change_rate ?? 0,
      netBuyAmtEok: item.netBuyAmtEok,
      droppedFromDate: comparedDate,
    };
  });

  return { list, targetDays, comparedDate };
}

/**
 * 2-2. 단타 종합랭킹 - 라이브 앱(kisApi.ts의 executeKisComprehensiveRankingFetch)과 동일한 하이브리드
 * 비선형(RMS) 가중 공식을 원본 데이터로 그대로 재현한다. 거래량증가율은 직전 수집된 영업일 대비로
 * 계산하고, 캔들강도는 이번에 새로 채운 시가/고가/저가(open_price/high_price/low_price)를 사용한다.
 */
export async function calculateComprehensiveFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams
): Promise<InvestorRankingResponse> {
  const market = params.market || 'ALL';
  const limit = params.limit || 50;
  const dateLabel = formatDateLabel(normalizedDate);

  const rawRecords = await loadRawDailyRecordsForDate(normalizedDate);
  const filtered = rawRecords
    .filter((r) => market === 'ALL' || resolveMarketType(r.symbol) === market)
    .filter((r) => !isEtfOrEtn(r.name));

  if (filtered.length === 0) {
    return {
      type: 'comprehensive', direction: 'buy', period: params.period || '1d', list: [],
      isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel,
    };
  }

  // 거래량 증가율 계산용: 이 날짜 바로 이전에 수집된 영업일의 거래량
  const twoDayWindow = await loadRawRecordsForDateRange(normalizedDate, 2);
  const prevGroup = twoDayWindow.find((g) => g.date !== normalizedDate);
  const prevVolumeMap = new Map<string, number>();
  (prevGroup?.records || []).forEach((r) => prevVolumeMap.set(r.symbol, r.volume));

  // 라이브 앱과 동일: 등락률/거래량/거래대금 상위 60개씩의 합집합을 후보군으로 삼는다
  const TOP_N = 60;
  const byFluc = [...filtered].sort((a, b) => (b.change_rate || 0) - (a.change_rate || 0)).slice(0, TOP_N);
  const byVol = [...filtered].sort((a, b) => b.volume - a.volume).slice(0, TOP_N);
  const byAmt = [...filtered].sort((a, b) => b.close_price * b.volume - a.close_price * a.volume).slice(0, TOP_N);

  const candidateMap = new Map<string, RawDailyInvestorRecord>();
  [...byFluc, ...byVol, ...byAmt].forEach((r) => { if (!candidateMap.has(r.symbol)) candidateMap.set(r.symbol, r); });
  const candidates = [...candidateMap.values()];
  const N = candidates.length;

  const withDerived = candidates.map((r) => {
    const amountEok = Number(((r.close_price * r.volume) / 100000000).toFixed(1));
    const prevVol = prevVolumeMap.get(r.symbol) || 0;
    const volumeIncreaseRate = prevVol > 0 ? Number((((r.volume - prevVol) / prevVol) * 100).toFixed(1)) : 0;
    return { r, amountEok, volumeIncreaseRate };
  });

  const flucRankMap = new Map([...withDerived].sort((a, b) => (b.r.change_rate || 0) - (a.r.change_rate || 0)).map((e, idx) => [e.r.symbol, idx + 1]));
  const amtRankMap = new Map([...withDerived].sort((a, b) => b.amountEok - a.amountEok).map((e, idx) => [e.r.symbol, idx + 1]));
  const volIncRankMap = new Map([...withDerived].sort((a, b) => b.r.volume - a.r.volume).map((e, idx) => [e.r.symbol, idx + 1]));

  const trendScoreOf = (e: { r: RawDailyInvestorRecord; volumeIncreaseRate: number }) => {
    const cr = e.r.change_rate || 0;
    if (cr <= 0) return 20;
    const isStrong = e.volumeIncreaseRate > 100 && cr > 5;
    return isStrong ? Math.min(75 + cr * 1.5, 100) : Math.min(45 + cr * 1.2, 70);
  };
  const trendAlignRankMap = new Map([...withDerived].sort((a, b) => trendScoreOf(b) - trendScoreOf(a)).map((e, idx) => [e.r.symbol, idx + 1]));

  const closeStrengthOf = (e: { r: RawDailyInvestorRecord }) => {
    const r = e.r;
    const cr = r.change_rate || 0;
    if (cr >= 29.5) return 100;
    const high = r.high_price || Math.max(r.close_price, r.open_price || r.close_price);
    const low = r.low_price || Math.min(r.close_price, r.open_price || r.close_price);
    if (high > low) return ((r.close_price - low) / (high - low)) * 100;
    return cr > 0 ? Math.min(60 + cr * 1.2, 95) : 30;
  };
  const closeStrengthRankMap = new Map([...withDerived].sort((a, b) => closeStrengthOf(b) - closeStrengthOf(a)).map((e, idx) => [e.r.symbol, idx + 1]));

  // 외국인/기관 순위: 이 날짜(시장 필터 적용) 전체 순매수 순위 (후보군 60개 한정이 아니라 시장 전체 기준)
  const foreignSorted = [...filtered].filter((r) => r.foreign_net_buy_amt > 0).sort((a, b) => b.foreign_net_buy_amt - a.foreign_net_buy_amt);
  const foreignRankMap = new Map(foreignSorted.map((r, idx) => [r.symbol, idx + 1]));
  const N_foreign = foreignSorted.length || 20;

  const organSorted = [...filtered].filter((r) => r.organ_net_buy_amt > 0).sort((a, b) => b.organ_net_buy_amt - a.organ_net_buy_amt);
  const organRankMap = new Map(organSorted.map((r, idx) => [r.symbol, idx + 1]));
  const N_organ = organSorted.length || 20;

  const scored: RankingItem[] = withDerived.map(({ r, amountEok, volumeIncreaseRate }) => {
    const flucRank = flucRankMap.get(r.symbol) || N;
    const amtRank = amtRankMap.get(r.symbol) || N;
    const volIncRank = volIncRankMap.get(r.symbol) || N;
    const trendAlignRank = trendAlignRankMap.get(r.symbol) || N;
    const closeStrengthRank = closeStrengthRankMap.get(r.symbol) || N;

    const flucScore = N > 1 ? Number((((N - flucRank) / (N - 1)) * 100).toFixed(1)) : 100;
    const amtScore = N > 1 ? Number((((N - amtRank) / (N - 1)) * 100).toFixed(1)) : 100;
    const volIncScore = N > 1 ? Number((((N - volIncRank) / (N - 1)) * 100).toFixed(1)) : 100;

    const cr = r.change_rate || 0;
    let trendAlignScore = 30;
    if (cr > 0) {
      const isStrong = volumeIncreaseRate > 100 && cr > 5;
      trendAlignScore = Number((isStrong ? Math.min(75 + cr * 1.5, 100) : Math.min(45 + cr * 1.2, 70)).toFixed(1));
    }

    let closeStrengthScore: number;
    if (cr >= 29.5) {
      closeStrengthScore = 100;
    } else {
      const high = r.high_price || Math.max(r.close_price, r.open_price || r.close_price);
      const low = r.low_price || Math.min(r.close_price, r.open_price || r.close_price);
      if (high > low) {
        closeStrengthScore = Number((Math.min(Math.max((r.close_price - low) / (high - low), 0), 1) * 100).toFixed(1));
      } else if (cr > 0) {
        closeStrengthScore = Number(Math.min(60 + cr * 1.2, 95).toFixed(1));
      } else {
        closeStrengthScore = 30;
      }
    }

    const fRank = foreignRankMap.get(r.symbol) || null;
    const foreignScore = fRank ? Number((100 - ((fRank - 1) / Math.max(N_foreign, 1)) * 50).toFixed(1)) : 20;

    const oRank = organRankMap.get(r.symbol) || null;
    const organScore = oRank ? Number((100 - ((oRank - 1) / Math.max(N_organ, 1)) * 50).toFixed(1)) : 20;

    // Group 1: Momentum Burst (Vol 35% + Amt 30% + Fluc 20% = 85%) Non-linear RMS
    const momSqSum = 35 * Math.pow(volIncScore, 2) + 30 * Math.pow(amtScore, 2) + 20 * Math.pow(flucScore, 2);
    const momRmsScore = Math.sqrt(momSqSum / 85);
    // Group 2: Confirmation (Trend 8% + Candle 2% + Foreign 2.5% + Organ 2.5% = 15%) Linear
    const confLinearScore = (trendAlignScore * 8 + closeStrengthScore * 2 + foreignScore * 2.5 + organScore * 2.5) / 15;
    const totalScore = Number((momRmsScore * 0.85 + confLinearScore * 0.15).toFixed(1));

    const scoreBreakdown: ScoreBreakdown = {
      totalScore, flucScore, amtScore, volIncScore, volScore: volIncScore,
      foreignScore, organScore, trendAlignScore, closeStrengthScore,
      flucRank, amtRank, volIncRank, volRank: volIncRank,
      foreignRank: fRank, organRank: oRank,
      trendAlignRank, closeStrengthRank,
    };

    return {
      rank: 0,
      symbol: r.symbol,
      name: r.name,
      market: resolveMarketType(r.symbol),
      currentPrice: r.close_price,
      change: 0,
      changeRate: cr,
      volume: r.volume,
      volumeIncreaseRate,
      openPrice: r.open_price,
      highPrice: r.high_price,
      lowPrice: r.low_price,
      ratioVsVolume: 0,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      amountEok,
      scoreBreakdown,
      asOfDateLabel: dateLabel,
    };
  });

  scored.sort((a, b) => (b.scoreBreakdown?.totalScore || 0) - (a.scoreBreakdown?.totalScore || 0));
  const list = scored.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));

  return {
    type: 'comprehensive',
    direction: 'buy',
    period: params.period || '1d',
    list,
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

  // 수급교집합 2일/3일연속은 단일 날짜 원본이 아니라 여러 영업일을 이어서 봐야 하므로 별도 경로로 분기
  if (params.type === 'overlap' && (params.mode === 'consecutive2d' || params.mode === 'consecutive3d')) {
    return calculateConsecutiveOverlapFromHistory(normalizedDate, params, params.mode === 'consecutive3d' ? 3 : 2);
  }

  // 단타 종합랭킹도 거래량증가율 계산을 위해 전일 원본이 추가로 필요해 별도 경로로 분기
  if (params.type === 'comprehensive') {
    return calculateComprehensiveFromHistory(normalizedDate, params);
  }

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
