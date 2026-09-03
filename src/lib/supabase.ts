import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabasePublicClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

function getSupabaseUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL ||
    'https://spyffsvzqldefmjnolql.supabase.co';
  return url.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
}

function getSupabaseAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  return key.trim();
}

function getSupabaseServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || getSupabaseAnonKey();
  return key.trim();
}

export function getSupabasePublic(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  if (!url || !key) {
    return null;
  }
  if (!supabasePublicClient) {
    supabasePublicClient = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return supabasePublicClient;
}

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceKey();
  if (!url || !key) {
    return null;
  }
  if (!supabaseAdminClient) {
    supabaseAdminClient = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return supabaseAdminClient;
}

export interface KisTokenRecord {
  access_token: string;
  expires_at: number; // ms timestamp
  updated_at?: string;
}

/**
 * Supabase DB에서 id=1 토큰 읽기 (읽기 전용)
 */
export async function fetchTokenFromSupabase(): Promise<KisTokenRecord | null> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) {
    const url = getSupabaseUrl();
    const key = getSupabaseServiceKey();
    console.warn(`[Supabase Warning] DB 조회를 건너땁니다. (URL 존재: ${Boolean(url)}, KEY 존재: ${Boolean(key)})`);
    return null;
  }

  try {
    const { data, error } = await client
      .from('kis_tokens')
      .select('access_token, expires_at, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      console.error('[Supabase DB Read Error]', error.message, error.details || '');
      return null;
    }

    if (data && data.access_token) {
      const expiresAtMs = new Date(data.expires_at).getTime();
      return {
        access_token: data.access_token,
        expires_at: expiresAtMs,
        updated_at: data.updated_at,
      };
    } else {
      console.warn('[Supabase DB Empty] kis_tokens 테이블에 id=1 레코드가 없거나 access_token이 비어있습니다.');
    }
  } catch (e: any) {
    console.error('[Supabase Exception]', e?.message || e);
  }

  return null;
}

/**
 * Supabase DB id=1 토큰 갱신 저장 (Vercel Cron / 초기화 스크립트 전 전용)
 */
export async function saveTokenToSupabase(accessToken: string, expiresAtMs: number): Promise<boolean> {
  const client = getSupabaseAdmin();
  if (!client) {
    console.error('[Supabase Error] SUPABASE_SERVICE_ROLE_KEY 미설정으로 저장 불가.');
    return false;
  }

  try {
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    const updatedAtIso = new Date().toISOString();

    const { error } = await client
      .from('kis_tokens')
      .upsert(
        {
          id: 1,
          access_token: accessToken,
          expires_at: expiresAtIso,
          updated_at: updatedAtIso,
        },
        { onConflict: 'id' }
      );

    if (error) {
      console.error('[Supabase DB Save Error]', error.message);
      return false;
    }

    console.log(`[Supabase Save Success] id=1 토큰 저장 완료 (만료시각: ${expiresAtIso})`);
    return true;
  } catch (e: any) {
    console.error('[Supabase Save Exception]', e?.message || e);
    return false;
  }
}

/**
 * Supabase DB kis_credits 테이블에서 여러 종목 신용상태 일괄 조회
 */
export async function fetchCreditBatchFromSupabase(symbols: string[]): Promise<Record<string, boolean>> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client || !symbols || symbols.length === 0) return {};

  try {
    const { data, error } = await client
      .from('kis_credits')
      .select('symbol, is_credit')
      .in('symbol', symbols);

    if (error) {
      console.warn('[Supabase kis_credits Read Error]', error.message);
      return {};
    }

    const resultMap: Record<string, boolean> = {};
    if (data) {
      data.forEach((row: any) => {
        if (row.symbol) {
          resultMap[row.symbol] = Boolean(row.is_credit);
        }
      });
    }
    return resultMap;
  } catch (e: any) {
    return {};
  }
}

/**
 * Supabase DB kis_credits 테이블에 여러 종목 신용상태 일괄 UPSERT 저장
 */
export async function saveCreditBatchToSupabase(entries: Array<{ symbol: string; is_credit: boolean }>): Promise<boolean> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client || !entries || entries.length === 0) return false;

  try {
    const records = entries.map((e) => ({
      symbol: e.symbol,
      is_credit: e.is_credit,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await client
      .from('kis_credits')
      .upsert(records, { onConflict: 'symbol' });

    if (error) {
      console.error('[Supabase kis_credits Save Error]', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[Supabase kis_credits Save Exception]', e?.message || e);
    return false;
  }
}

/**
 * Supabase DB intraday_3m_candles 테이블에서 특정 날짜/종목의 3분봉 배열 조회
 * (서버리스 인스턴스가 바뀌어도 유실되지 않는 영구 저장소 - 로컬 디스크 아카이브의 대체/보강용)
 */
export async function fetchIntraday3mCandlesFromSupabase(date: string, symbol: string): Promise<any[] | null> {
  if (!date || !symbol) return null;
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('intraday_3m_candles')
      .select('candles')
      .eq('date', date)
      .eq('symbol', symbol)
      .maybeSingle();

    if (error) {
      console.warn('[Supabase intraday_3m_candles Read Error]', error.message);
      return null;
    }

    if (data && Array.isArray(data.candles) && data.candles.length > 0) {
      return data.candles;
    }
  } catch (e: any) {
    console.warn('[Supabase intraday_3m_candles Read Exception]', e?.message || e);
  }
  return null;
}

/**
 * Supabase DB intraday_3m_candles 테이블에서 특정 날짜에 "실제로 조회되어 저장된 적 있는" 심볼과
 * 그 시점의 봉 개수 목록을 반환한다. 큐레이션된 TOP_300_STOCKS 밖의 종목(검색으로 연 임의 종목 등)도
 * 그날 한 번이라도 조회됐으면 이 목록에 잡혀서, EOD 아카이빙 크론이 "완전체(130개)로 다시 채워야 할
 * 대상"으로 추가 포함시킬 수 있다 (archive-3m-candles route.ts에서 사용).
 */
export async function listIntraday3mCandleStatusForDate(date: string): Promise<Array<{ symbol: string; count: number }>> {
  if (!date) return [];
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('intraday_3m_candles')
      .select('symbol, candles')
      .eq('date', date);

    if (error) {
      console.warn('[Supabase intraday_3m_candles List Error]', error.message);
      return [];
    }
    return (data || []).map((row: any) => ({
      symbol: row.symbol,
      count: Array.isArray(row.candles) ? row.candles.length : 0,
    }));
  } catch (e: any) {
    console.warn('[Supabase intraday_3m_candles List Exception]', e?.message || e);
    return [];
  }
}

/**
 * Supabase DB intraday_3m_candles 테이블에 특정 날짜/종목의 3분봉 배열 UPSERT 저장
 */
export async function saveIntraday3mCandlesToSupabase(date: string, symbol: string, candles: any[]): Promise<boolean> {
  if (!date || !symbol || !candles || candles.length === 0) return false;
  const client = getSupabaseAdmin();
  if (!client) return false;

  try {
    const { error } = await client
      .from('intraday_3m_candles')
      .upsert(
        {
          date,
          symbol,
          candles,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'date,symbol' }
      );

    if (error) {
      console.warn('[Supabase intraday_3m_candles Save Error]', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[Supabase intraday_3m_candles Save Exception]', e?.message || e);
    return false;
  }
}

export interface RawDailyInvestorRecord {
  date: string; // YYYYMMDD (e.g. '20260827')
  symbol: string; // '005930'
  name: string; // '삼성전자'
  close_price: number;
  open_price?: number;
  high_price?: number;
  low_price?: number;
  volume: number;
  change_rate?: number;
  foreign_net_buy_qty: number;
  foreign_net_buy_amt: number;
  organ_net_buy_qty: number;
  organ_net_buy_amt: number;
  program_net_buy_qty?: number;
  program_net_buy_amt?: number;
  raw_payload?: any;
  created_at?: string;
}

/**
 * Supabase DB raw_daily_data 테이블 및 로컬 디스크 파일(scratch/raw_daily_data/)에 원본 데이터 동시 적재
 */
export async function saveRawDailyDataToSupabase(records: RawDailyInvestorRecord[]): Promise<boolean> {
  if (!records || records.length === 0) return false;

  // 1. Local File Store Persistence (offline audit guarantee)
  // 🚨 [버그 수정] vercel.json이 하루 수집을 2개 크론(startIdx 0~148 / 148~295)으로 쪼개 호출하는데,
  // 예전 코드는 매 호출마다 이번 회차의 records만으로 파일 전체를 fs.writeFileSync로 덮어써서
  // 나중에 실행된 크론이 먼저 저장된 절반을 통째로 지워버렸다 (실측: 20260902.json이 295건 중
  // 147건만 남는 손상 발생). symbol 키 기준으로 기존 파일과 병합(upsert)한 뒤 저장해야 한다.
  try {
    const fs = require('fs');
    const path = require('path');
    const targetDate = records[0]?.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${targetDate}.json`);
    const merged = new Map<string, RawDailyInvestorRecord>();
    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(existing)) {
          existing.forEach((r: RawDailyInvestorRecord) => { if (r?.symbol) merged.set(r.symbol, r); });
        }
      } catch (_) {}
    }
    records.forEach((r) => { if (r?.symbol) merged.set(r.symbol, r); });
    const mergedRecords = [...merged.values()];

    fs.writeFileSync(filePath, JSON.stringify(mergedRecords, null, 2), 'utf8');
    console.log(`[Raw Data File Saved] 원본 데이터 로컬 적재 완료(병합): ${filePath} (이번 회차 ${records.length}건 + 기존 병합 후 총 ${mergedRecords.length}개 종목)`);
  } catch (e: any) {
    console.error('[Raw Data Local Save Error]', e?.message || e);
  }

  // 2. Supabase DB Upsert
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return false;

  try {
    const upsertRows = records.map(r => ({
      date: r.date,
      symbol: r.symbol,
      name: r.name,
      close_price: r.close_price,
      open_price: r.open_price || 0,
      high_price: r.high_price || 0,
      low_price: r.low_price || 0,
      volume: r.volume,
      change_rate: r.change_rate || 0,
      foreign_net_buy_qty: r.foreign_net_buy_qty || 0,
      foreign_net_buy_amt: r.foreign_net_buy_amt || 0,
      organ_net_buy_qty: r.organ_net_buy_qty || 0,
      organ_net_buy_amt: r.organ_net_buy_amt || 0,
      program_net_buy_qty: r.program_net_buy_qty || 0,
      program_net_buy_amt: r.program_net_buy_amt || 0,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await client
      .from('raw_daily_data')
      .upsert(upsertRows, { onConflict: 'date,symbol' });

    if (error) {
      console.warn('[Supabase raw_daily_data Save Notice]', error.message);
      return false;
    }

    console.log(`[Supabase Raw Saved] raw_daily_data 적재 완료 (${upsertRows.length}건)`);
    return true;
  } catch (e: any) {
    console.error('[Supabase raw_daily_data Save Exception]', e?.message || e);
    return false;
  }
}

export interface RawDailyTrailingRow {
  date: string;
  symbol: string;
  foreign_net_buy_amt: number;
  organ_net_buy_amt: number;
  program_net_buy_amt: number;
}

/**
 * raw_daily_data(장마감 후 자동 수집 - 수칙 참고: src/app/api/cron/collect-raw-daily-data/route.ts)에서
 * beforeDate(당일) "이전"의 최근 영업일 tradingDaysBack개치를 종목별로 묶어 반환한다.
 * 라이브 앱의 2일/3일연속 계산이 "과거일자 게이트 사전필터"에 사용 - 서버 인메모리 예열 캐시
 * (batchCollector.ts의 trend5dBatchStore)와 달리 서버리스 재시작/HMR에도 사라지지 않는 영구 소스다.
 */
export async function fetchRawDailyTrailingDays(
  beforeDate: string,
  tradingDaysBack: number
): Promise<{ dates: string[]; bySymbol: Map<string, Map<string, RawDailyTrailingRow>> }> {
  const empty = { dates: [] as string[], bySymbol: new Map<string, Map<string, RawDailyTrailingRow>>() };
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client || tradingDaysBack <= 0) return empty;

  try {
    // 1. beforeDate 이전에 실제로 기록된 distinct 날짜 중 최근 tradingDaysBack개를 찾는다.
    const { data: dateRows, error: dateErr } = await client
      .from('raw_daily_data')
      .select('date')
      .lt('date', beforeDate)
      .order('date', { ascending: false })
      .limit(tradingDaysBack * 320); // 종목별로 여러 행이 섞여 오므로 넉넉히 조회 후 distinct 처리

    if (dateErr || !dateRows) return empty;

    const distinctDates = [...new Set(dateRows.map((r: any) => r.date as string))]
      .sort()
      .reverse()
      .slice(0, tradingDaysBack)
      .sort();

    if (distinctDates.length === 0) return { dates: [], bySymbol: new Map() };

    const { data, error } = await client
      .from('raw_daily_data')
      .select('date, symbol, foreign_net_buy_amt, organ_net_buy_amt, program_net_buy_amt')
      .in('date', distinctDates);

    if (error || !data) return { dates: distinctDates, bySymbol: new Map() };

    const bySymbol = new Map<string, Map<string, RawDailyTrailingRow>>();
    data.forEach((row: any) => {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, new Map());
      bySymbol.get(row.symbol)!.set(row.date, row as RawDailyTrailingRow);
    });

    return { dates: distinctDates, bySymbol };
  } catch (e: any) {
    console.warn('[Supabase raw_daily_data Trailing Read Exception]', e?.message || e);
    return empty;
  }
}

export interface ConsecutiveOverlapWatchRow {
  symbol: string;
  name: string;
  status: 'active' | 'dropped';
  ranksByType?: any;
  netBuyAmtEok?: number;
  dropReason?: string;
}

/**
 * consecutive_overlap_watch 테이블에서 오늘자 특정 조건(연속일수/방향/시장)의 스냅샷을 조회한다.
 * status 필터를 안 주면 active/dropped 전부 반환한다.
 */
export async function fetchConsecutiveOverlapWatch(
  date: string,
  targetDays: number,
  direction: string,
  market: string,
  status?: 'active' | 'dropped'
): Promise<Array<ConsecutiveOverlapWatchRow & { droppedAt?: string; updatedAt?: string }>> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return [];

  try {
    let query = client
      .from('consecutive_overlap_watch')
      .select('symbol, name, status, ranks_by_type, net_buy_amt_eok, drop_reason, dropped_at, updated_at')
      .eq('date', date)
      .eq('target_days', targetDays)
      .eq('direction', direction)
      .eq('market', market);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) {
      console.warn('[Supabase consecutive_overlap_watch Read Error]', error.message);
      return [];
    }

    return (data || []).map((row: any) => ({
      symbol: row.symbol,
      name: row.name,
      status: row.status,
      ranksByType: row.ranks_by_type,
      netBuyAmtEok: row.net_buy_amt_eok,
      dropReason: row.drop_reason,
      droppedAt: row.dropped_at,
      updatedAt: row.updated_at,
    }));
  } catch (e: any) {
    console.warn('[Supabase consecutive_overlap_watch Read Exception]', e?.message || e);
    return [];
  }
}

/**
 * consecutive_overlap_watch에서 beforeDate(오늘) "이전"의 가장 최근 영업일에 active였던 스냅샷을 조회한다.
 * 오늘 첫 계산(당일 스냅샷이 아직 없는 시점)에도 "어제 마감 대비 오늘 이탈"을 즉시 잡아내기 위해 사용 -
 * 히스토리 페이지의 "직전 영업일 대비 비교" 방식과 라이브 탭의 이탈 판정 기준을 통일한다.
 */
export async function fetchLatestActiveBeforeDate(
  beforeDate: string,
  targetDays: number,
  direction: string,
  market: string
): Promise<Array<ConsecutiveOverlapWatchRow & { date?: string }>> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return [];

  try {
    // 1. 이 조건으로 기록된 날짜 중 beforeDate보다 이전인 가장 최근 날짜를 찾는다.
    const { data: dateRows, error: dateErr } = await client
      .from('consecutive_overlap_watch')
      .select('date')
      .eq('target_days', targetDays)
      .eq('direction', direction)
      .eq('market', market)
      .eq('status', 'active')
      .lt('date', beforeDate)
      .order('date', { ascending: false })
      .limit(1);

    if (dateErr || !dateRows || dateRows.length === 0) return [];
    const latestDate = dateRows[0].date;

    // 2. 그 날짜의 active 스냅샷 전체를 조회한다.
    const { data, error } = await client
      .from('consecutive_overlap_watch')
      .select('symbol, name, status, ranks_by_type, net_buy_amt_eok, drop_reason, dropped_at, updated_at')
      .eq('date', latestDate)
      .eq('target_days', targetDays)
      .eq('direction', direction)
      .eq('market', market)
      .eq('status', 'active');

    if (error) {
      console.warn('[Supabase fetchLatestActiveBeforeDate Read Error]', error.message);
      return [];
    }

    return (data || []).map((row: any) => ({
      symbol: row.symbol,
      name: row.name,
      status: row.status,
      ranksByType: row.ranks_by_type,
      netBuyAmtEok: row.net_buy_amt_eok,
      dropReason: row.drop_reason,
      date: latestDate,
    }));
  } catch (e: any) {
    console.warn('[Supabase fetchLatestActiveBeforeDate Exception]', e?.message || e);
    return [];
  }
}

/**
 * consecutive_overlap_watch 테이블에 오늘자 종목 상태(active/dropped)를 일괄 UPSERT한다.
 */
export async function upsertConsecutiveOverlapWatch(
  date: string,
  targetDays: number,
  direction: string,
  market: string,
  rows: ConsecutiveOverlapWatchRow[]
): Promise<boolean> {
  if (!rows || rows.length === 0) return true;
  const client = getSupabaseAdmin();
  if (!client) return false;

  try {
    const upsertRows = rows.map((r) => ({
      date,
      target_days: targetDays,
      direction,
      market,
      symbol: r.symbol,
      name: r.name,
      status: r.status,
      ranks_by_type: r.ranksByType ?? null,
      net_buy_amt_eok: r.netBuyAmtEok ?? null,
      drop_reason: r.dropReason ?? null,
      dropped_at: r.status === 'dropped' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await client
      .from('consecutive_overlap_watch')
      .upsert(upsertRows, { onConflict: 'date,target_days,direction,market,symbol' });

    if (error) {
      console.warn('[Supabase consecutive_overlap_watch Save Error]', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[Supabase consecutive_overlap_watch Save Exception]', e?.message || e);
    return false;
  }
}

/**
 * daily_overlap_first_seen 테이블에서 오늘자(date) 당일교집합 종목들의 "최초 포착 시각"을 일괄 조회한다.
 * key는 symbol, value는 first_seen_at(ISO 문자열)이다.
 */
export async function fetchDailyOverlapFirstSeen(
  date: string,
  direction: string
): Promise<Record<string, string>> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return {};

  try {
    const { data, error } = await client
      .from('daily_overlap_first_seen')
      .select('symbol, first_seen_at')
      .eq('date', date)
      .eq('direction', direction);

    if (error) {
      console.warn('[Supabase daily_overlap_first_seen Read Error]', error.message);
      return {};
    }

    const map: Record<string, string> = {};
    (data || []).forEach((row: any) => {
      map[row.symbol] = row.first_seen_at;
    });
    return map;
  } catch (e: any) {
    console.warn('[Supabase daily_overlap_first_seen Read Exception]', e?.message || e);
    return {};
  }
}

/**
 * daily_overlap_first_seen 테이블에 "오늘 처음 보는 종목"만 INSERT한다.
 * ignoreDuplicates: true(= ON CONFLICT DO NOTHING)로 동작하기 때문에, 이미 기록이 있는
 * (date, symbol, direction) 조합은 절대 덮어쓰지 않는다 - 그래야 "최초" 포착 시각이 보존된다.
 */
export async function insertDailyOverlapFirstSeenIfMissing(
  date: string,
  direction: string,
  rows: Array<{ symbol: string; name: string }>
): Promise<boolean> {
  if (!rows || rows.length === 0) return true;
  const client = getSupabaseAdmin();
  if (!client) return false;

  try {
    const insertRows = rows.map((r) => ({ date, direction, symbol: r.symbol, name: r.name }));

    const { error } = await client
      .from('daily_overlap_first_seen')
      .upsert(insertRows, { onConflict: 'date,symbol,direction', ignoreDuplicates: true });

    if (error) {
      console.warn('[Supabase daily_overlap_first_seen Insert Error]', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[Supabase daily_overlap_first_seen Insert Exception]', e?.message || e);
    return false;
  }
}

// ============================================================================
// 🏷️ shared_rank_cache: "전 탭 뱃지 모음"(getStockBadgeSummary)이 Vercel의 서로 다른
// 서버리스 컨테이너끼리도 서로의 랭킹 계산 결과를 볼 수 있게 하는 공유 캐시.
//
// 🚨 [설계 원칙] 이 테이블은 RLS가 켜져 있고 anon/authenticated 정책이 하나도 없다 - 반드시
// getSupabaseAdmin()(SERVICE_ROLE_KEY, 서버 전용 - 클라이언트 번들에 절대 노출 안 됨)으로만
// 접근해야 한다. getSupabasePublic()(브라우저에도 노출되는 anon key)으로는 RLS에 막혀 이
// 테이블을 절대 못 읽는다 - 실수로라도 getSupabasePublic()을 이 함수들에 섞어 쓰지 말 것.
// 쓰기는 전부 fire-and-forget(실패해도 조용히 넘어감 - 캐시 갱신 실패가 화면 응답을 막으면 안 됨).
// ============================================================================

export interface SharedRankCacheEntry {
  cacheKey: string;
  list: any[];
  updatedAt: string;
}

/**
 * 랭킹 계산이 끝난 직후 fire-and-forget으로 호출 - 응답을 기다리게 하지 않는다.
 * 실패해도(RLS 미설정, 테이블 미생성 등) 조용히 넘어간다 - 인메모리 캐시가 여전히
 * 정상 동작하므로 이 저장 실패가 사용자에게 보이는 기능을 막아서는 안 된다.
 */
export async function upsertSharedRankCache(cacheKey: string, list: any[]): Promise<void> {
  if (!list || list.length === 0) return;
  const client = getSupabaseAdmin();
  if (!client) return;

  try {
    const { error } = await client
      .from('shared_rank_cache')
      .upsert({ cache_key: cacheKey, list, updated_at: new Date().toISOString() }, { onConflict: 'cache_key' });
    if (error) {
      console.warn('[Supabase shared_rank_cache Upsert Error]', error.message);
    }
  } catch (e: any) {
    console.warn('[Supabase shared_rank_cache Upsert Exception]', e?.message || e);
  }
}

/**
 * 여러 cache_key를 한 번의 IN 쿼리로 일괄 조회한다 - 뱃지 조회 하나당 카테고리 수만큼
 * 개별 쿼리를 날리지 않기 위함. maxAgeMs보다 오래된 행은 결과에서 제외한다(뱃지가 옛날
 * 순위를 마치 지금 순위인 것처럼 보여주는 걸 막기 위한 안전장치 - 수칙 1-5와 같은 취지).
 */
export async function fetchSharedRankCacheBatch(
  cacheKeys: string[],
  maxAgeMs: number = 5 * 60 * 1000
): Promise<Map<string, any[]>> {
  const result = new Map<string, any[]>();
  if (!cacheKeys || cacheKeys.length === 0) return result;
  const client = getSupabaseAdmin();
  if (!client) return result;

  try {
    const { data, error } = await client
      .from('shared_rank_cache')
      .select('cache_key, list, updated_at')
      .in('cache_key', cacheKeys);

    if (error) {
      console.warn('[Supabase shared_rank_cache Batch Read Error]', error.message);
      return result;
    }

    const now = Date.now();
    (data || []).forEach((row: any) => {
      if (!row.list || now - new Date(row.updated_at).getTime() > maxAgeMs) return;
      result.set(row.cache_key, row.list);
    });
    return result;
  } catch (e: any) {
    console.warn('[Supabase shared_rank_cache Batch Read Exception]', e?.message || e);
    return result;
  }
}

