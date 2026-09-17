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
  SurgingRankItem,
  isEtfOrEtn,
} from './types';
import { TOP_300_STOCKS } from './stockUniverse300';
import { getSupabaseAdmin, getSupabasePublic, RawDailyInvestorRecord, fetchWsWatchlist, fetchDiscoverySnapshots, fetchPrecursorSnapshots } from './supabase';
import { resolveMarketType, resolveStockPriceAndChange } from './mockData';
import { getGlobalMap } from './globalCache';
import { fetchKisRecentDailyBars, fetchKisIndexDailyTrend } from './kisApi';

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
  // 🎯 [기능 추가 - 사용자 요청: "수급교집합 장마감 후보만도 히스토리에 남겨"] 라이브 탭
  // (InvestorRankingTable.tsx "장마감 후보만" 토글, kisApi.ts fetchKisQuietAccumulationCandidates)과
  // 동일한 역발상 필터를 히스토리 당일/2일연속/3일연속 교집합 위에도 얹을 수 있게 하는 플래그.
  quietFilter?: boolean;
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

// 🚨 [버그 수정 - 수칙 1-3/1-5] 날짜 파라미터가 8자리로 정리되지 않으면 에러 없이 '20260828'
// (특정 과거 날짜)로 조용히 대체하고 있었다 - 화면엔 오늘 날짜를 요청했다고 표시되는데 실제로는 항상
// 그 하드코딩된 날짜의 데이터를 보여주는 셈이었다. 호출부(API 라우트)가 이미 try/catch로 에러를
// 500 응답으로 변환하므로, 여기서는 잘못된 입력을 조용히 삼키지 말고 명시적으로 실패시킨다.
export function normalizeDate(rawDate: string): string {
  const cleaned = rawDate.replace(/[^0-9]/g, '');
  if (cleaned.length === 8) return cleaned;
  throw new Error(`잘못된 날짜 형식입니다: "${rawDate}" (YYYYMMDD 8자리 숫자여야 합니다)`);
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
// 🚨 [버그 수정 - 사용자 지적: "배포된 히스토리에 다음날 결과 다 미수집으로 뜨는데. 로컬에서는 잘뜨는구만"]
// listAvailableRawDates()의 Supabase 조회 결과를 짧게 캐시한다 - 배포 환경에선 scratch/ 로컬 디스크
// 폴백이 아예 없어(.gitignore로 배포 번들에서 제외) 매 요청마다 전체 페이지네이션을 다시 도는 건
// 낭비다. 날짜 목록은 하루 한 번(장마감 후 배치 수집) 외엔 안 바뀌므로 5분이면 충분하다.
const AVAILABLE_DATES_CACHE_TTL_MS = 5 * 60 * 1000;
const availableDatesCacheStore = getGlobalMap<'dates', { data: string[]; timestamp: number }>('historyAvailableDatesCache');

export async function listAvailableRawDates(): Promise<string[]> {
  const cached = availableDatesCacheStore.get('dates');
  if (cached && Date.now() - cached.timestamp < AVAILABLE_DATES_CACHE_TTL_MS) {
    return cached.data;
  }

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

  // 🚨 [버그 수정 - 실측: scratch/diagnose_next_day_missing.js] 예전 코드는 order 절 없이
  // .limit(2000)만 걸어서, raw_daily_data(현재 29,129행, 계속 증가)의 기본 반환 순서상 가장 오래된
  // 4일치(20260424~20260429)만 돌아왔다 - 로컬에선 위 로컬 디스크 폴백이 전체 날짜를 갖고 있어서
  // 가려졌지만, scratch/가 배포되지 않는 Vercel 프로덕션에서는 이 4일짜리 목록이 전부라 "다음 영업일"을
  // 영원히 못 찾아 항상 "미수집"으로 떴다. date 컬럼만(행당 8바이트) 끝까지 페이지네이션해서 완전한
  // 날짜 목록을 만든다 - 테이블이 수십만 행으로 커져도 date 컬럼만이라 전송량이 작아 안전하다.
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (client) {
    try {
      // 🚨 [진단 스크립트로 실측 확인 - scratch/diagnose_next_day_missing.js] PostgREST가 서버 설정상
      // 요청 range/limit과 무관하게 응답을 최대 1000행으로 잘라 보낸다(실측: range(0,4999) 요청해도
      // 실제로는 1000행만 옴). 순차 while 루프로 끝까지 돌면 정확하긴 하지만(실측 31회 왕복, 3.9초)
      // Vercel 서버리스 기본 타임아웃(10초)에 위험할 만큼 가깝다 - 먼저 count(head 요청, ~0.2초)로
      // 전체 행 수를 알아낸 뒤, 필요한 페이지를 한꺼번에 Promise.all로 병렬 조회한다(실측 총 1.2초로
      // 3배 이상 단축, 결과는 순차 방식과 100% 동일하게 99일치 전부 확인 - scratch/verify_fix_real_client.js).
      const PAGE_SIZE = 1000;
      const { count, error: countError } = await client
        .from('raw_daily_data')
        .select('date', { count: 'exact', head: true });
      if (countError || !count) {
        console.warn('[History Layer A] Supabase 행 수 조회 실패:', countError);
      } else {
        const pageCount = Math.ceil(count / PAGE_SIZE);
        const pages = await Promise.all(
          Array.from({ length: pageCount }, (_, i) =>
            client.from('raw_daily_data').select('date').range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
          )
        );
        pages.forEach(({ data, error }) => {
          if (!error && data) data.forEach((row: any) => row.date && dateSet.add(row.date));
        });
      }
    } catch (e) {
      console.warn('[History Layer A] Supabase 날짜 목록 조회 실패:', e);
    }
  }

  const result = [...dateSet].sort();
  availableDatesCacheStore.set('dates', { data: result, timestamp: Date.now() });
  return result;
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
 * 🎯 [기능 추가 - 사용자 요청: "장마감 후보군들이 다음날 실제로 상승했는지 보고싶어"] 특정 날짜(normalizedDate)
 * 기준 "다음 영업일"(raw_daily_data에 실제로 수집된 다음 날짜)의 원본을 찾아 반환한다. 아직 다음날이
 * 수집 안 됐으면(가장 최근 거래일 등) null - 가짜 0%로 채우지 않는다(수칙 1-3).
 */
async function loadNextTradingDayRecords(normalizedDate: string): Promise<{ date: string; records: RawDailyInvestorRecord[] } | null> {
  const availableDates = await listAvailableRawDates();
  const nextDate = availableDates.find((d) => d > normalizedDate);
  if (!nextDate) return null;
  const records = await loadRawDailyRecordsForDate(nextDate);
  if (records.length === 0) return null;
  return { date: nextDate, records };
}

function formatShortDateLabel(dateStr: string): string {
  if (dateStr.length !== 8) return dateStr;
  return `${parseInt(dateStr.slice(4, 6), 10)}/${parseInt(dateStr.slice(6, 8), 10)}`;
}

/** 종목별 다음 영업일 종가와 비교해 nextDayChangeRate/nextDayDateLabel을 덧붙인다(순수 함수, 부수효과 없음). */
function attachNextDayResults(list: RankingItem[], nextDay: { date: string; records: RawDailyInvestorRecord[] } | null): RankingItem[] {
  if (!nextDay) return list;
  const nextMap = new Map(nextDay.records.map((r) => [r.symbol, r]));
  const label = formatShortDateLabel(nextDay.date);
  return list.map((item) => {
    const nextRecord = nextMap.get(item.symbol);
    if (!nextRecord || !nextRecord.close_price || !item.currentPrice) return item;
    const nextDayChangeRate = Number((((nextRecord.close_price - item.currentPrice) / item.currentPrice) * 100).toFixed(2));
    // 다음날 고가가 없는 레코드(구버전 수집분)는 종가로 대체하지 않고 그냥 undefined로 남긴다 -
    // 가짜로 종가=고가라고 표시하면 "장중에도 안 뛰었다"는 잘못된 신호를 준다(수칙 1-3).
    const nextDayHighChangeRate = nextRecord.high_price
      ? Number((((nextRecord.high_price - item.currentPrice) / item.currentPrice) * 100).toFixed(2))
      : undefined;
    return { ...item, nextDayChangeRate, nextDayDateLabel: label, nextDayHighChangeRate };
  });
}

/**
 * 🎯 [기능 추가 - 사용자 요청: "히스토리에 장마감후보군도 업데이트해야지" + "다음날 실제로 상승했는지
 * 보고싶어"] 라이브 fetchKisPostMarketCandidates(kisApi.ts)와 동일한 후보 선정 기준(급등주 교집합
 * 2개 이상 + 고가마감·변동폭·기관매수우위 점수)을 raw_daily_data 원본만으로 재구성한다 - 이 지표들이
 * 전부 이미 그 날의 원본(open/high/low/close/organ_net_buy_amt)에 있어서 KIS 재호출 없이 계산 가능하다
 * (수칙 1-6). 여기에 다음 영업일 실제 종가까지 붙여 "이 후보군이 진짜 다음날 올랐는지"를 보여준다.
 */
export async function calculatePostMarketFromHistory(
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
      type: 'postmarket', direction: 'buy', period: params.period || '1d', list: [],
      isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel,
    };
  }

  // 라이브 fetchKisSurgingOverlap과 동일한 후보군 구성 (SURGE_TOP_N=60, 등락률 3%+ 게이트, 2개 이상 겹침)
  const SURGE_TOP_N = 60;
  const byFluc = [...filtered].filter((r) => (r.change_rate || 0) >= 3.0).sort((a, b) => (b.change_rate || 0) - (a.change_rate || 0)).slice(0, SURGE_TOP_N);
  const byVol = [...filtered].sort((a, b) => b.volume - a.volume).slice(0, SURGE_TOP_N);
  const byAmt = [...filtered].sort((a, b) => (b.close_price * b.volume) - (a.close_price * a.volume)).slice(0, SURGE_TOP_N);

  const flucRankMap = new Map(byFluc.map((r, idx) => [r.symbol, idx + 1]));
  const volRankMap = new Map(byVol.map((r, idx) => [r.symbol, idx + 1]));
  const amtRankMap = new Map(byAmt.map((r, idx) => [r.symbol, idx + 1]));

  const withModes = byFluc
    .map((r) => {
      const surgingRanks: SurgingRankItem[] = [{ type: 'fluctuation', label: '등락률', rank: flucRankMap.get(r.symbol)! }];
      if (volRankMap.has(r.symbol)) surgingRanks.push({ type: 'volume', label: '거래량', rank: volRankMap.get(r.symbol)! });
      if (amtRankMap.has(r.symbol)) surgingRanks.push({ type: 'amount', label: '거래대금', rank: amtRankMap.get(r.symbol)! });
      return { r, surgingRanks };
    })
    .filter((x) => x.surgingRanks.length >= 2);

  // 🚨 [실측 기반 - kisApi.ts enrichCandidatesWithNarrowRangeScore와 동일 공식 재사용] KIS 재호출 없이
  // 그 날 원본(open/high/low/close/organ_net_buy_amt)만으로 그대로 재구성한다.
  const scored: RankingItem[] = withModes.map(({ r, surgingRanks }) => {
    const high = r.high_price || Math.max(r.close_price, r.open_price || r.close_price);
    const low = r.low_price || Math.min(r.close_price, r.open_price || r.close_price);
    const close = r.close_price;
    const range = high - low;
    const todayRangePct = close > 0 ? Number(((range / close) * 100).toFixed(1)) : 0;
    const closePositionPct = range > 0 ? Number((((close - low) / range) * 100).toFixed(0)) : 50;
    const organStrong = (r.organ_net_buy_amt || 0) > 0;
    const overlapCount = surgingRanks.length;
    const postMarketScore = Number((overlapCount * 20 + closePositionPct * 0.3 + Math.max(0, 30 - todayRangePct) + (organStrong ? 15 : 0)).toFixed(1));
    const surgingBadge = `${surgingRanks.map((s) => `${s.label} ${s.rank}위`).join(' · ')} · 고가마감 ${closePositionPct}% · 변동폭 ${todayRangePct}%${organStrong ? ' · 기관매수우위' : ''}`;

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
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      amountEok: Number(((r.close_price * r.volume) / 100000000).toFixed(1)),
      overlapCount,
      surgingModes: surgingRanks.map((s) => s.type),
      surgingRanks,
      surgingBadge,
      todayRangePct,
      closePositionPct,
      postMarketScore,
      asOfDateLabel: dateLabel,
    };
  });

  scored.sort((a, b) => (b.postMarketScore || 0) - (a.postMarketScore || 0));
  const list = scored.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));

  const nextDay = await loadNextTradingDayRecords(normalizedDate);
  const withNextDay = attachNextDayResults(list, nextDay);

  return {
    type: 'postmarket',
    direction: 'buy',
    period: params.period || '1d',
    list: withNextDay,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
  };
}

/**
 * 🎯 [기능 추가 - 사용자 요청: "수급교집합 장마감 후보만도 히스토리에 남겨. 그것도 장마감 후보처럼
 * 얼마나 올랐는지 두개 보여주고"] 라이브 "장마감 후보만" 토글(kisApi.ts scoreQuietAccumCandidates)과
 * 동일한 역발상 점수(종가위치·거래량배율·5일누적수익률 - 셋 다 낮을수록 고득점)를 기준 수급교집합
 * (당일/2일연속/3일연속) 후보군 위에 그대로 얹어 재구성한다(수칙 1-6 - 새 공식 만들지 않고 그대로 재현).
 * 기준 후보군 자체는 이미 검증된 calculateRankingsFromRawRecords/calculateConsecutiveOverlapFromHistory를
 * 재사용하고, 여기선 거래량배율·5일누적수익률 계산에 필요한 최근 5거래일 lookback만 추가로 붙인다.
 */
export async function calculateQuietAccumFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams,
  baseMode: 'daily' | 'consecutive2d' | 'consecutive3d'
): Promise<InvestorRankingResponse> {
  const direction = params.direction || 'buy';
  const limit = params.limit || 50;
  const dateLabel = formatDateLabel(normalizedDate);
  const periodLabel = (baseMode === 'consecutive2d' ? 'consecutive2d' : baseMode === 'consecutive3d' ? 'consecutive3d' : params.period || '1d') as RankingPeriod;

  const emptyResponse = (error?: string): InvestorRankingResponse => ({
    type: 'overlap', direction, period: periodLabel, list: [],
    isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel, error,
  });

  // 1. 기준 교집합 후보군 재사용 - 이미 검증된 로직 그대로, "장마감 후보만"이 아닌 상태와 동일한 후보군을 씀
  let baseCandidates: RankingItem[];
  if (baseMode === 'daily') {
    const rawRecords = await loadRawDailyRecordsForDate(normalizedDate);
    baseCandidates = calculateRankingsFromRawRecords(rawRecords, { ...params, type: 'overlap' }, normalizedDate).list;
  } else {
    baseCandidates = (await calculateConsecutiveOverlapFromHistory(normalizedDate, params, baseMode === 'consecutive3d' ? 3 : 2)).list;
  }
  if (baseCandidates.length === 0) return emptyResponse();

  // 2. 종가위치/거래량배율/5일누적수익률 계산용 최근 6영업일(오늘 포함) lookback - 부족하면 가짜로
  // 채우지 않고 이유를 명시한 빈 결과를 반환한다(수칙 1-3).
  const dateGroups = await loadRawRecordsForDateRange(normalizedDate, 6);
  if (dateGroups.length < 6 || dateGroups[dateGroups.length - 1]?.date !== normalizedDate) {
    return emptyResponse(`${normalizedDate} 기준 5거래일치 lookback 원본이 부족해 장마감 후보만 점수를 계산할 수 없습니다.`);
  }
  const orderedDates = dateGroups.map((g) => g.date);
  const trailingDates = orderedDates.slice(0, -1); // 오늘을 제외한 최근 5거래일
  const bySymbol = new Map<string, Map<string, RawDailyInvestorRecord>>();
  dateGroups.forEach(({ date, records }) => {
    records.forEach((r) => {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Map());
      bySymbol.get(r.symbol)!.set(date, r);
    });
  });

  type Enriched = RankingItem & { closePositionPct: number; volRatioPct: number; cum5dReturnPct: number };
  const enriched: Enriched[] = [];
  baseCandidates.forEach((item) => {
    const symbolDates = bySymbol.get(item.symbol);
    // 5거래일 이력이 전부 없는 종목(신규상장 등)은 percentile 계산을 왜곡하지 않도록 후보군에서 제외
    if (!symbolDates || !trailingDates.every((d) => symbolDates.has(d)) || !symbolDates.has(normalizedDate)) return;
    const today = symbolDates.get(normalizedDate)!;
    const high = today.high_price || today.close_price;
    const low = today.low_price || today.close_price;
    const range = high - low;
    const closePositionPct = range > 0 ? Number((((today.close_price - low) / range) * 100).toFixed(0)) : 50;
    const priorVols = trailingDates.map((d) => symbolDates.get(d)!.volume || 0);
    const avgVol5 = priorVols.reduce((sum, v) => sum + v, 0) / priorVols.length;
    const volRatioPct = avgVol5 > 0 ? Number((((today.volume || 0) / avgVol5) * 100).toFixed(1)) : 100;
    const fiveDaysAgoClose = symbolDates.get(trailingDates[0])!.close_price || 0;
    const cum5dReturnPct = fiveDaysAgoClose > 0 ? Number((((today.close_price - fiveDaysAgoClose) / fiveDaysAgoClose) * 100).toFixed(2)) : 0;
    enriched.push({ ...item, closePositionPct, volRatioPct, cum5dReturnPct });
  });
  if (enriched.length === 0) {
    return emptyResponse('5거래일 이력이 온전한 종목이 없어 장마감 후보만 점수를 계산할 수 없습니다.');
  }

  // 3. 라이브(kisApi.ts scoreQuietAccumCandidates)와 동일한 역발상 percentile 스코어링 - 셋 다
  // "낮을수록" 고득점이라 (100 - percentile)로 뒤집는다.
  const percentileOf = (values: number[], target: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    let idx = sorted.findIndex((v) => v >= target);
    if (idx === -1) idx = sorted.length - 1;
    return (idx / sorted.length) * 100;
  };
  const closeVals = enriched.map((r) => r.closePositionPct);
  const volVals = enriched.map((r) => r.volRatioPct);
  const momVals = enriched.map((r) => r.cum5dReturnPct);
  const maxOverlap = Math.max(...enriched.map((r) => r.overlapCount || 2), 3);

  enriched.forEach((item) => {
    const closeScore = 100 - percentileOf(closeVals, item.closePositionPct);
    const volScore = 100 - percentileOf(volVals, item.volRatioPct);
    const momScore = 100 - percentileOf(momVals, item.cum5dReturnPct);
    const overlapScore = maxOverlap > 2 ? (((item.overlapCount || 2) - 2) / (maxOverlap - 2)) * 100 : 0;
    item.postMarketScore = Number((closeScore * 0.3 + volScore * 0.3 + momScore * 0.3 + overlapScore * 0.1).toFixed(1));
  });

  enriched.sort((a, b) => (b.postMarketScore || 0) - (a.postMarketScore || 0));
  const list = enriched.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));

  const nextDay = await loadNextTradingDayRecords(normalizedDate);
  const withNextDay = attachNextDayResults(list, nextDay);

  return {
    type: 'overlap',
    direction,
    period: periodLabel,
    list: withNextDay,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
  };
}

/**
 * 🎯 [기능 추가 - 사용자 요청: "히스토리에 관심종목도 업데이트해야지"] 관심종목(ws_watchlist)은 "시장 전체
 * 랭킹"이 아니라 사용자가 고른 개별 종목 목록이라, 다른 탭처럼 그 날짜의 원본에서 순위를 새로 매기는 게
 * 아니라 "지금 등록된 관심종목들이 그 날짜에 각각 어땠는지" 조회로 구성한다. 다음날 결과도 함께 붙인다.
 */
export async function calculateWatchlistFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams
): Promise<InvestorRankingResponse> {
  const dateLabel = formatDateLabel(normalizedDate);
  const watchlist = await fetchWsWatchlist();

  if (watchlist.length === 0) {
    return {
      type: 'watchlist', direction: 'buy', period: params.period || '1d', list: [],
      isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel,
      error: '등록된 관심종목이 없습니다. 실시간 탭에서 먼저 관심종목을 추가해주세요.',
    };
  }

  const rawRecords = await loadRawDailyRecordsForDate(normalizedDate);
  const recordMap = new Map(rawRecords.map((r) => [r.symbol, r]));

  // 🚨 [버그 수정 - 사용자 지적: "미투온 왜 원본 데이터가 없다는거야"] TOP_300_STOCKS 밖의 관심종목은
  // raw_daily_data 수집 크론(batchCollector.ts runRawDailyDataBackfill)이 이제부터는 같이 모으지만,
  // 이미 지나간 최근 날짜(예: 어제·그제)는 그걸로 못 채운다. KIS 일봉 조회(fetchKisRecentDailyBars,
  // 오늘 기준 최근 40일치)에서 해당 날짜를 직접 찾아 대체한다 - 외국인/기관/프로그램 순매수는 이 API에
  // 없어 0으로 남지만, 관심종목 탭은 애초에 이 3개 필드를 전부 0으로만 표시하므로(순매수 개념이 없는
  // 개별 종목 시세 탭) 정보 손실이 없다. 40일보다 오래된 날짜는 이 폴백으로도 복구 불가 - 그런 날짜는
  // 그대로 "원본 데이터 없음"으로 정직하게 표시된다(수칙 1-3 - 가짜 값으로 채우지 않음).
  const missingFromArchive = watchlist.filter((w) => !recordMap.has(w.symbol));
  if (missingFromArchive.length > 0) {
    const fallbackResults = await Promise.all(
      missingFromArchive.map(async (w) => {
        const bars = await fetchKisRecentDailyBars(w.symbol).catch(() => undefined);
        if (!bars) return null;
        const idx = bars.findIndex((b) => b.date === normalizedDate);
        if (idx === -1) return null;
        const bar = bars[idx];
        const prevClose = idx > 0 ? bars[idx - 1].close : bar.open;
        const changeRate = prevClose > 0 ? Number((((bar.close - prevClose) / prevClose) * 100).toFixed(2)) : 0;
        const record: RawDailyInvestorRecord = {
          date: normalizedDate,
          symbol: w.symbol,
          name: w.name || w.symbol,
          close_price: bar.close,
          open_price: bar.open,
          high_price: bar.high,
          low_price: bar.low,
          volume: bar.volume,
          change_rate: changeRate,
          foreign_net_buy_qty: 0,
          foreign_net_buy_amt: 0,
          organ_net_buy_qty: 0,
          organ_net_buy_amt: 0,
        };
        return record;
      })
    );
    fallbackResults.forEach((r) => { if (r) recordMap.set(r.symbol, r); });
  }

  const found = watchlist
    .map((w) => recordMap.get(w.symbol))
    .filter((r): r is RawDailyInvestorRecord => !!r);

  const list: RankingItem[] = found
    .map((r) => ({
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
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      amountEok: Number(((r.close_price * r.volume) / 100000000).toFixed(1)),
      openPrice: r.open_price,
      highPrice: r.high_price,
      lowPrice: r.low_price,
      asOfDateLabel: dateLabel,
    }))
    .sort((a, b) => b.changeRate - a.changeRate)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));

  const nextDay = await loadNextTradingDayRecords(normalizedDate);
  const withNextDay = attachNextDayResults(list, nextDay);

  const missingSymbols = watchlist.filter((w) => !recordMap.has(w.symbol));

  return {
    type: 'watchlist',
    direction: 'buy',
    period: params.period || '1d',
    list: withNextDay,
    isMock: false,
    updatedAt: new Date().toISOString(),
    lastBatchTime: dateLabel,
    error: missingSymbols.length > 0
      ? `${missingSymbols.map((s) => s.name || s.symbol).join(', ')}은(는) 이 날짜 원본 데이터가 없어 제외됐습니다.`
      : undefined,
  };
}

/**
 * 🎯 [기능 추가 - 사용자 요청: "히스토리도 장마감 후보군 업데이트 해줘"] "발굴 장마감"은 raw_daily_data
 * 재구성이 아니라 매일 14:30(KST) cron이 저장해둔 discovery_snapshots 스냅샷을 그대로 읽는다 - 이
 * 탭 자체가 "장마감 확정치"가 아니라 "장마감 직전 잠정 데이터" 기반이라 과거로 소급 재현이 불가능하고,
 * 크론이 실제로 돈 날짜부터만 데이터가 쌓인다(수칙 1-3 - 없는 과거를 가짜로 채우지 않음). 다음날
 * 결과는 다른 히스토리 탭과 동일하게 raw_daily_data(장마감 확정치)에서 가져와 붙인다.
 */
/**
 * 🎯 [기능 추가 - 사용자 지적: "발굴, 전조는 계산 안되어서 진짜 못하는거야?"] 발굴 장마감 8개 조건 중
 * 6개(거래대금·거래량 배율, 종가위치, 저점상승, 외국인·기관 매집)는 raw_daily_data만으로 재구성
 * 가능하다. 나머지 2개는 근사/생략한다:
 *   - 매집 주체: 라이브는 "14:30 장중 추정치"를 쓰지만 여기선 raw_daily_data의 "장마감 확정 순매수"로
 *     대체한다(방향이 다를 수 있는 근사치 - 정직하게 알아둘 것).
 *   - 오후 매수세 비중: 하루 안의 시간대별 데이터가 raw_daily_data엔 아예 없어 계산 불가 - 0점 처리
 *     (해당 15점은 그냥 못 받는 것으로 정직하게 남긴다, 가짜 값 금지 - 수칙 1-3).
 * 상대강도는 KOSPI/KOSDAQ 지수 일봉을 라이브로 1회씩만 조회해(종목 수와 무관, 수칙 1-6) 계산한다.
 */
async function reconstructDiscoveryFromRawData(
  normalizedDate: string,
  market: MarketType,
  limit: number
): Promise<RankingItem[]> {
  const dateGroups = await loadRawRecordsForDateRange(normalizedDate, 22);
  if (dateGroups.length < 22 || dateGroups[dateGroups.length - 1]?.date !== normalizedDate) return [];

  const orderedDates = dateGroups.map((g) => g.date);
  const bySymbol = new Map<string, Map<string, RawDailyInvestorRecord>>();
  dateGroups.forEach(({ date, records }) => {
    records.forEach((r) => {
      if (market !== 'ALL' && resolveMarketType(r.symbol) !== market) return;
      if (isEtfOrEtn(r.name)) return;
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Map());
      bySymbol.get(r.symbol)!.set(date, r);
    });
  });

  // 지수(KOSPI/KOSDAQ) 그날 등락률 - 종목 전체가 공유하므로 딱 2회만 라이브 조회
  const indexChangeRate: { KOSPI: number; KOSDAQ: number } = { KOSPI: 0, KOSDAQ: 0 };
  await Promise.all(
    (['KOSPI', 'KOSDAQ'] as const).map(async (m) => {
      try {
        const trend = await fetchKisIndexDailyTrend(m, '60d', false);
        const days = trend?.trend || [];
        const idx = days.findIndex((d) => d.date === normalizedDate);
        if (idx > 0) {
          const prevClose = days[idx - 1].closePrice;
          if (prevClose > 0) indexChangeRate[m] = Number((((days[idx].closePrice - prevClose) / prevClose) * 100).toFixed(2));
        }
      } catch (e) {
        console.warn(`[Discovery History Reconstruct] ${m} 지수 조회 실패:`, (e as any)?.message || e);
      }
    })
  );

  const ramp = (value: number | undefined, from: number, to: number, maxScore: number): number => {
    if (value === undefined) return 0;
    if (value <= from) return 0;
    if (value >= to) return maxScore;
    return Number((((value - from) / (to - from)) * maxScore).toFixed(2));
  };

  const candidates: RankingItem[] = [];
  const todayRecords = dateGroups[dateGroups.length - 1].records;
  todayRecords.forEach((today) => {
    if (market !== 'ALL' && resolveMarketType(today.symbol) !== market) return;
    if (isEtfOrEtn(today.name)) return;
    const symDates = bySymbol.get(today.symbol);
    if (!symDates || !orderedDates.every((d) => symDates.has(d))) return;

    const history = orderedDates.map((d) => symDates.get(d)!);
    const todayRow = history[history.length - 1];
    const amount = (r: RawDailyInvestorRecord) => r.close_price * r.volume;

    const prior20 = history.slice(0, -1);
    const avgAmount = prior20.reduce((s, r) => s + amount(r), 0) / prior20.length;
    const avgVolume = prior20.reduce((s, r) => s + r.volume, 0) / prior20.length;
    const volumeSurgeRatio = avgAmount > 0 ? Number((amount(todayRow) / avgAmount).toFixed(2)) : undefined;
    const rawVolumeSurgeRatio = avgVolume > 0 ? Number(((todayRow.volume || 0) / avgVolume).toFixed(2)) : undefined;

    const high = todayRow.high_price || todayRow.close_price;
    const closeToHighRatioPct = high > 0 ? Number(((todayRow.close_price / high) * 100).toFixed(2)) : undefined;

    const priorForLow = history.slice(0, -1); // 오늘 제외, 오름차순
    let higherLowPattern: boolean | undefined;
    if (priorForLow.length >= 10) {
      const recentLow = Math.min(...priorForLow.slice(-5).map((r) => r.low_price || r.close_price));
      const priorLow = Math.min(...priorForLow.slice(-10, -5).map((r) => r.low_price || r.close_price));
      higherLowPattern = recentLow > priorLow;
    }

    // 🚨 [버그 수정 - 실측으로 발견: scratch/backtest_discovery_history.js] 20260611처럼 KIS가 아직
    // 확정 순매수를 반영하기 전에 raw_daily_data가 수집된 날은 외국인/기관 순매수가 전부 정확히 0으로
    // 저장돼 있다(batchCollector.ts의 isSettled 체크와 동일 현상). 이걸 "0은 매수가 아니니 매도 우위"로
    // 잘못 판정하면, 그런 날은 295종목 전부가 "매도 우위"로 몰려 후보가 하루 통째로 0개가 되는 게
    // 실측 확인됐다(77일 중 48일이 이 이유로 통째로 날아감). 0 하나만 있어도 됐던 게 아니라 "둘 다
    // 정확히 0"인 경우만 미확정으로 보고, 그때는 매도 우위로 단정하지 않는다.
    const isSettled = (todayRow.foreign_net_buy_amt || 0) !== 0 || (todayRow.organ_net_buy_amt || 0) !== 0;
    const fBuy = (todayRow.foreign_net_buy_amt || 0) > 0;
    const oBuy = (todayRow.organ_net_buy_amt || 0) > 0;
    let absorptionDirection: 'foreign' | 'organ' | 'both' | 'none' = 'none';
    let absorptionBadge = '데이터 없음';
    if (isSettled) {
      if (fBuy && oBuy) { absorptionDirection = 'both'; absorptionBadge = '외국인+기관 동시 매수'; }
      else if (fBuy) { absorptionDirection = 'foreign'; absorptionBadge = '외국인 매수 우위'; }
      else if (oBuy) { absorptionDirection = 'organ'; absorptionBadge = '기관 매수 우위'; }
      else { absorptionDirection = 'none'; absorptionBadge = '외국인·기관 매도 우위'; }
    }

    // 🚨 [수급 필터 - 라이브와 동일] 외국인+기관 둘 다 확정 순매도(미확정 아님)면 후보에서 제외
    if (absorptionBadge === '외국인·기관 매도 우위') return;

    const marketKey = (resolveMarketType(today.symbol) === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI') as 'KOSPI' | 'KOSDAQ';
    const relativeStrengthPct = Number(((todayRow.change_rate || 0) - indexChangeRate[marketKey]).toFixed(2));

    const amountSurgeScore = ramp(volumeSurgeRatio, 1, 3, 15);
    const rawVolumeSurgeScore = ramp(rawVolumeSurgeRatio, 1, 3, 5);
    const closeToHighScore = ramp(closeToHighRatioPct, 80, 90, 10);
    const higherLowScore = higherLowPattern ? 15 : 0;
    const afternoonScore = 0; // raw_daily_data엔 시간대별 데이터가 없어 계산 불가 - 정직하게 0점
    const relativeScore = ramp(relativeStrengthPct, 0, 5, 15);
    const foreignScore = fBuy ? 12 : 0;
    const organScore = oBuy ? 13 : 0;
    const discoveryScore = Number((amountSurgeScore + rawVolumeSurgeScore + closeToHighScore + higherLowScore + afternoonScore + relativeScore + foreignScore + organScore).toFixed(1));

    candidates.push({
      rank: 0,
      symbol: today.symbol,
      name: today.name,
      market: marketKey,
      currentPrice: todayRow.close_price,
      change: 0,
      changeRate: todayRow.change_rate || 0,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume: 0,
      ratioVsVolume: 0,
      absorptionDirection,
      absorptionBadge,
      volumeSurgeRatio,
      relativeStrengthPct,
      discoveryScore,
    });
  });

  candidates.sort((a, b) => (b.discoveryScore || 0) - (a.discoveryScore || 0));
  return candidates.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));
}

export async function calculateDiscoveryFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams
): Promise<InvestorRankingResponse> {
  const dateLabel = formatDateLabel(normalizedDate);
  const market = params.market || 'ALL';
  const limit = params.limit || 50;

  const rows = await fetchDiscoverySnapshots(normalizedDate);
  let filtered: RankingItem[] = (market === 'ALL' ? rows : rows.filter((r) => r.market === market))
    .slice(0, limit)
    .map((r) => ({
      rank: r.rank || 0,
      symbol: r.symbol,
      name: r.name,
      market: r.market,
      currentPrice: r.current_price,
      change: 0,
      changeRate: r.change_rate,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume: 0,
      ratioVsVolume: 0,
      absorptionDirection: r.absorption_direction as any,
      absorptionBadge: r.absorption_badge,
      afternoonVolumeRatioPct: r.afternoon_volume_ratio_pct,
      volumeSurgeRatio: r.volume_surge_ratio,
      pullbackFromHighPct: r.pullback_from_high_pct,
      relativeStrengthPct: r.relative_strength_pct,
      discoveryScore: r.discovery_score,
      asOfDateLabel: dateLabel,
    }));

  let reconstructed = false;
  if (filtered.length === 0) {
    filtered = await reconstructDiscoveryFromRawData(normalizedDate, market, limit);
    reconstructed = true;
    filtered = filtered.map((item) => ({ ...item, asOfDateLabel: dateLabel }));
  }

  if (filtered.length === 0) {
    return {
      type: 'discovery', direction: 'buy', period: params.period || '1d', list: [],
      isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel,
      error: `${dateLabel} 기준 20거래일치 원본 데이터가 부족해 발굴 장마감을 계산할 수 없습니다.`,
    };
  }

  const nextDay = await loadNextTradingDayRecords(normalizedDate);
  const withNextDay = attachNextDayResults(filtered, nextDay);

  return {
    type: 'discovery',
    direction: 'buy',
    period: params.period || '1d',
    list: withNextDay,
    isMock: false,
    updatedAt: new Date().toISOString(),
    // 🚨 [정직 표시 - 수칙 1-5] 재구성치는 "장중 14:30 시점"이 아니라 "장마감 확정치" 기반 근사이고,
    // 오후 매수세 지표는 계산 자체가 빠져 있다는 걸 명시한다.
    lastBatchTime: reconstructed ? `${dateLabel} (장마감 확정치로 재구성 - 매집주체는 확정 기준, 오후매수세 미계산)` : dateLabel,
  };
}

/** 전조 장마감 히스토리 - calculateDiscoveryFromHistory와 동일 패턴, precursor_snapshots 재사용. */
// 전조 장마감 4개 조건 배점 - kisApi.ts fetchKisPrecursorCandidates의 절대 점수제와 동일 공식(수칙 1-6).
const PRECURSOR_MIN_SURGE_RATIO = 1.5;
const PRECURSOR_MAX_RECENT_RETURN_PCT_H = 15;
const PRECURSOR_MAX_TODAY_CHANGE_PCT_H = 8;
function rampScore(value: number | undefined, from: number, to: number, maxScore: number): number {
  if (value === undefined) return 0;
  if (value <= from) return 0;
  if (value >= to) return maxScore;
  return Number((((value - from) / (to - from)) * maxScore).toFixed(2));
}

/**
 * 🎯 [기능 추가 - 사용자 지적: "발굴, 전조는 계산 안되어서 진짜 못하는거야? 히스토리는 기록을
 * 남겨놓을텐데 거기서 하면 안되나?"] 전조 장마감의 4개 조건(거래대금급증·증가추세·다이버전스·고가유지)은
 * 투자자동향 추정치나 3분봉 같은 "장중에만 존재하는" 데이터가 전혀 필요 없다 - raw_daily_data(일봉
 * 종가/고가/저가/거래량)만으로 완전히 재구성 가능하다(실측 백테스트로 확인 - scratch/
 * backtest_precursor_history.js). precursor_snapshots에 그 날짜 스냅샷이 없으면(과거 날짜, 또는 아직
 * 크론이 안 돈 날) 이 재구성으로 대체한다.
 * ⚠️ 라이브 버전은 장마감 "전"(14:40) 시점 데이터로 계산하지만, 여기선 raw_daily_data의 장마감 확정치
 * (하루 전체 거래량/고가)를 쓴다 - "급등 장마감"(calculatePostMarketFromHistory)도 동일한 근사를 이미
 * 쓰고 있어 이 코드베이스의 기존 관례와 일치한다.
 */
async function reconstructPrecursorFromRawData(
  normalizedDate: string,
  market: MarketType,
  limit: number
): Promise<RankingItem[]> {
  const dateGroups = await loadRawRecordsForDateRange(normalizedDate, 22); // 오늘 포함 22거래일(20일 평균 + 5일 수익률 + 오늘)
  if (dateGroups.length < 22 || dateGroups[dateGroups.length - 1]?.date !== normalizedDate) return [];

  const orderedDates = dateGroups.map((g) => g.date);
  const bySymbol = new Map<string, Map<string, RawDailyInvestorRecord>>();
  dateGroups.forEach(({ date, records }) => {
    records.forEach((r) => {
      if (market !== 'ALL' && resolveMarketType(r.symbol) !== market) return;
      if (isEtfOrEtn(r.name)) return;
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Map());
      bySymbol.get(r.symbol)!.set(date, r);
    });
  });

  const candidates: RankingItem[] = [];
  const todayRecords = dateGroups[dateGroups.length - 1].records;
  todayRecords.forEach((today) => {
    if (market !== 'ALL' && resolveMarketType(today.symbol) !== market) return;
    if (isEtfOrEtn(today.name)) return;
    const symDates = bySymbol.get(today.symbol);
    if (!symDates || !orderedDates.every((d) => symDates.has(d))) return; // 22일 이력 온전한 종목만

    const history = orderedDates.map((d) => symDates.get(d)!);
    const todayRow = history[history.length - 1];
    const amount = (r: RawDailyInvestorRecord) => r.close_price * r.volume;

    const fiveDaysAgo = history[history.length - 6];
    const recentReturnPct = fiveDaysAgo.close_price > 0
      ? Number((((todayRow.close_price - fiveDaysAgo.close_price) / fiveDaysAgo.close_price) * 100).toFixed(2))
      : 0;
    if (Math.abs(recentReturnPct) > PRECURSOR_MAX_RECENT_RETURN_PCT_H) return;
    if (Math.abs(todayRow.change_rate || 0) > PRECURSOR_MAX_TODAY_CHANGE_PCT_H) return;

    const prior20 = history.slice(0, -1);
    const avgAmount = prior20.reduce((s, r) => s + amount(r), 0) / prior20.length;
    const volumeSurgeRatio = avgAmount > 0 ? Number((amount(todayRow) / avgAmount).toFixed(2)) : 0;
    if (volumeSurgeRatio < PRECURSOR_MIN_SURGE_RATIO) return;

    const recent3 = history.slice(-3).reduce((s, r) => s + r.volume, 0) / 3;
    const prior3 = history.slice(-6, -3).reduce((s, r) => s + r.volume, 0) / 3;
    const volumeTrendIncreasing = prior3 > 0 && recent3 > prior3;

    const priceVolumeDivergence = Number((volumeSurgeRatio / (1 + Math.abs(todayRow.change_rate || 0))).toFixed(2));

    const high = todayRow.high_price || todayRow.close_price;
    const closeToHighRatioPct = high > 0 ? Number(((todayRow.close_price / high) * 100).toFixed(2)) : 100;

    const surgeScore = rampScore(volumeSurgeRatio, 1.5, 4, 35);
    const trendScore = volumeTrendIncreasing ? 20 : 0;
    const divergenceScore = rampScore(priceVolumeDivergence, 1, 5, 25);
    const closeToHighScore = rampScore(closeToHighRatioPct, 80, 95, 20);
    const precursorScore = Number((surgeScore + trendScore + divergenceScore + closeToHighScore).toFixed(1));

    candidates.push({
      rank: 0,
      symbol: today.symbol,
      name: today.name,
      market: resolveMarketType(today.symbol),
      currentPrice: todayRow.close_price,
      change: 0,
      changeRate: todayRow.change_rate || 0,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume: 0,
      ratioVsVolume: 0,
      recentReturnPct,
      volumeSurgeRatio,
      volumeTrendIncreasing,
      priceVolumeDivergence,
      closeToHighRatioPct,
      precursorScore,
    });
  });

  candidates.sort((a, b) => (b.precursorScore || 0) - (a.precursorScore || 0));
  return candidates.slice(0, limit).map((item, idx) => ({ ...item, rank: idx + 1 }));
}

export async function calculatePrecursorFromHistory(
  normalizedDate: string,
  params: HistoryQueryParams
): Promise<InvestorRankingResponse> {
  const dateLabel = formatDateLabel(normalizedDate);
  const market = params.market || 'ALL';
  const limit = params.limit || 50;

  const rows = await fetchPrecursorSnapshots(normalizedDate);
  let filtered: RankingItem[] = (market === 'ALL' ? rows : rows.filter((r) => r.market === market))
    .slice(0, limit)
    .map((r) => ({
      rank: r.rank || 0,
      symbol: r.symbol,
      name: r.name,
      market: r.market,
      currentPrice: r.current_price,
      change: 0,
      changeRate: r.change_rate,
      netBuyQty: 0,
      netBuyAmt: 0,
      netBuyAmtEok: 0,
      volume: 0,
      ratioVsVolume: 0,
      recentReturnPct: r.recent_return_pct,
      volumeSurgeRatio: r.volume_surge_ratio,
      volumeTrendIncreasing: r.volume_trend_increasing,
      priceVolumeDivergence: r.price_volume_divergence,
      closeToHighRatioPct: r.close_to_high_ratio_pct,
      precursorScore: r.precursor_score,
      asOfDateLabel: dateLabel,
    }));

  let reconstructed = false;
  if (filtered.length === 0) {
    filtered = await reconstructPrecursorFromRawData(normalizedDate, market, limit);
    reconstructed = true;
    filtered = filtered.map((item) => ({ ...item, asOfDateLabel: dateLabel }));
  }

  if (filtered.length === 0) {
    return {
      type: 'precursor', direction: 'buy', period: params.period || '1d', list: [],
      isMock: false, updatedAt: new Date().toISOString(), lastBatchTime: dateLabel,
      error: `${dateLabel} 기준 20거래일치 원본 데이터가 부족해 전조 장마감을 계산할 수 없습니다.`,
    };
  }

  const nextDay = await loadNextTradingDayRecords(normalizedDate);
  const withNextDay = attachNextDayResults(filtered, nextDay);

  return {
    type: 'precursor',
    direction: 'buy',
    period: params.period || '1d',
    list: withNextDay,
    isMock: false,
    updatedAt: new Date().toISOString(),
    // 실제 14:40 크론 스냅샷인지, raw_daily_data 장마감 확정치로 재구성한 값인지 구분해서 보여준다
    // (수칙 1-5 - 대체 데이터 출처 명시. 재구성치는 "장마감 전" 시점이 아니라 하루 전체 확정 데이터 기준).
    lastBatchTime: reconstructed ? `${dateLabel} (장마감 확정치로 재구성)` : dateLabel,
  };
}

/**
 * 3. 랭킹 조회 및 버전 무효화 / 원본 재계산 관리 함수
 */
export async function getHistoryRankingData(params: HistoryQueryParams): Promise<InvestorRankingResponse> {
  const normalizedDate = normalizeDate(params.date);

  // 🎯 [기능 추가 - "수급교집합 장마감 후보만도 히스토리에 남겨"] 기준 탭(당일/2일연속/3일연속)이 뭐든
  // quietFilter가 켜져 있으면 이 전용 경로로 분기 - 익일 실제 결과까지 붙여서 반환한다.
  if (params.type === 'overlap' && params.quietFilter) {
    const baseMode: 'daily' | 'consecutive2d' | 'consecutive3d' =
      params.mode === 'consecutive2d' ? 'consecutive2d' : params.mode === 'consecutive3d' ? 'consecutive3d' : 'daily';
    return calculateQuietAccumFromHistory(normalizedDate, params, baseMode);
  }

  // 수급교집합 2일/3일연속은 단일 날짜 원본이 아니라 여러 영업일을 이어서 봐야 하므로 별도 경로로 분기
  if (params.type === 'overlap' && (params.mode === 'consecutive2d' || params.mode === 'consecutive3d')) {
    return calculateConsecutiveOverlapFromHistory(normalizedDate, params, params.mode === 'consecutive3d' ? 3 : 2);
  }

  // 단타 종합랭킹도 거래량증가율 계산을 위해 전일 원본이 추가로 필요해 별도 경로로 분기
  if (params.type === 'comprehensive') {
    return calculateComprehensiveFromHistory(normalizedDate, params);
  }

  // 🎯 [기능 추가] 장마감 후보군(급등) - 다음날 실제 결과를 붙이는 별도 경로 (comprehensive와 동일 패턴)
  if (params.type === 'postmarket') {
    return calculatePostMarketFromHistory(normalizedDate, params);
  }

  // 🎯 [기능 추가 - 사용자 요청: "히스토리도 장마감 후보군 업데이트 해줘"] 장마감 후보군(발굴/전조) -
  // raw_daily_data 재구성이 아니라 discovery_snapshots/precursor_snapshots 스냅샷을 그대로 읽는다.
  if (params.type === 'discovery') {
    return calculateDiscoveryFromHistory(normalizedDate, params);
  }
  if (params.type === 'precursor') {
    return calculatePrecursorFromHistory(normalizedDate, params);
  }

  // 🎯 [기능 추가] 관심종목 - "그 날짜의 전체 랭킹"이 아니라 "지금 내 관심종목들의 그 날짜 실적 조회"라
  // 완전히 다른 경로(raw_daily_data 재계산이 아니라 심볼 목록 기준 조회)
  if (params.type === 'watchlist') {
    return calculateWatchlistFromHistory(normalizedDate, params);
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
