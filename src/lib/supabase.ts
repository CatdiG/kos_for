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

// 🚨 [버그 수정 - 근본 원인] createClient()에 fetch 타임아웃이 전혀 없었다 - kisApi.ts의 KIS 호출들이
// 오늘 겪은 것과 정확히 같은 패턴: Supabase 응답이 지연되면(네트워크 이슈, DB 부하 등) 그 요청이
// 영원히 pending 상태로 남을 수 있다. fetchOverlapRankingData의 기존 주석([kisApi.ts:2344] 참고)에
// "Supabase에서 완전 리스트를 읽어와 재사용하는 시도를 했다가 서버가 완전히 응답 불가(hang) 상태에
// 빠지는 사고가 있었다"는 실제 기록이 남아있는데, 이게 그 근본 원인이었을 가능성이 높다 - 이제
// shared_rank_cache를 다시 읽기 경로에 추가하기 전에, 모든 Supabase 호출에 일괄 타임아웃을 건다.
// supabase-js v2는 client 옵션의 global.fetch로 커스텀 fetch를 주입할 수 있어(공식 지원 API),
// 호출부마다 따로 손볼 필요 없이 여기 한 곳에서 전부 안전해진다(수칙 1-6).
const supabaseFetchWithTimeout: typeof fetch = (input, init) => {
  return fetch(input, { ...init, signal: AbortSignal.timeout(8000) });
};

export function getSupabasePublic(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  if (!url || !key) {
    return null;
  }
  if (!supabasePublicClient) {
    supabasePublicClient = createClient(url, key, {
      auth: { persistSession: false },
      global: { fetch: supabaseFetchWithTimeout },
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
      global: { fetch: supabaseFetchWithTimeout },
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

export interface CreditBatchRow {
  isCredit: boolean;
  updatedAtMs: number;
}

/**
 * Supabase DB kis_credits 테이블에서 여러 종목 신용상태 일괄 조회
 * 🚨 [버그 수정 - 사용자 지적: "두산에너빌리티는 신용 가능한데 왜 자꾸 가능했다가 안됐다고 뜨는거야?
 * 한번 저장하면 계속 쓰는거 아니었어?"] 원래는 is_credit만 읽어와서 호출부가 "언제 저장된 값인지"를
 * 전혀 알 수 없었다 - 실측: 두산에너빌리티(034020)가 8/28에 저장된 is_credit:false를 3주 뒤인 오늘도
 * (KIS 라이브 원본은 이미 Y=가능으로 바뀌었는데도) 그대로 신뢰해서 "불가"로 보여주고 있었다. updated_at을
 * 같이 읽어와서 호출부(mergeCreditStatusToRanking)가 오래된 행을 "확인됨"이 아니라 "재검증 필요"로
 * 구분할 수 있게 한다.
 */
export async function fetchCreditBatchFromSupabase(symbols: string[]): Promise<Record<string, CreditBatchRow>> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client || !symbols || symbols.length === 0) return {};

  try {
    const { data, error } = await client
      .from('kis_credits')
      .select('symbol, is_credit, updated_at')
      .in('symbol', symbols);

    if (error) {
      console.warn('[Supabase kis_credits Read Error]', error.message);
      return {};
    }

    const resultMap: Record<string, CreditBatchRow> = {};
    if (data) {
      data.forEach((row: any) => {
        if (row.symbol) {
          resultMap[row.symbol] = { isCredit: Boolean(row.is_credit), updatedAtMs: row.updated_at ? new Date(row.updated_at).getTime() : 0 };
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
 * 🎯 [KIS 실시간 웹소켓 브릿지 연동용] intraday_3m_candles에서 "최근 maxAgeMs 안에 갱신된" 데이터만
 * 반환한다. ws-bridge(오라클 서버, H0UNCNT0 통합체결가 상시 구독)가 15초 주기로 이 테이블에 쓰고
 * 있으므로, updated_at이 최근이면 REST(KRX전용 J, 애프터마켓 데이터 없음)보다 더 정확하고 더 넓은
 * 시간대(통합가·애프터마켓 포함)를 커버하는 데이터라는 뜻이다 - oldEnough하면(브릿지가 그 종목을
 * 감시 안 하거나 서버가 죽어있음) null을 반환해서 기존 REST 폴백 경로로 그대로 넘어가게 한다.
 */
export async function fetchFreshIntraday3mCandlesFromSupabase(
  date: string,
  symbol: string,
  maxAgeMs: number
): Promise<any[] | null> {
  if (!date || !symbol) return null;
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('intraday_3m_candles')
      .select('candles, updated_at')
      .eq('date', date)
      .eq('symbol', symbol)
      .maybeSingle();

    if (error) {
      console.warn('[Supabase intraday_3m_candles Freshness Read Error]', error.message);
      return null;
    }
    if (!data || !Array.isArray(data.candles) || data.candles.length === 0) return null;

    const updatedAtMs = new Date(data.updated_at).getTime();
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > maxAgeMs) return null;

    return data.candles;
  } catch (e: any) {
    console.warn('[Supabase intraday_3m_candles Freshness Read Exception]', e?.message || e);
    return null;
  }
}

/**
 * 🎯 [KIS 실시간 웹소켓 브릿지 관심종목 관리] "관심종목이 맨날 바뀌는데 어떻게 관리하냐"는 문제 해결용.
 * 오라클 서버를 SSH로 매번 고치는 대신, 이 테이블에 추가/삭제하면 ws-bridge가 30초마다 폴링해서
 * 자동으로 KIS 웹소켓 구독을 갱신한다(서버 재시작 불필요).
 */
export async function fetchWsWatchlist(): Promise<Array<{ symbol: string; name: string | null; added_at: string }>> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('ws_watchlist')
      .select('symbol, name, added_at')
      .order('added_at', { ascending: true });
    if (error) {
      console.warn('[Supabase ws_watchlist List Error]', error.message);
      return [];
    }
    return data || [];
  } catch (e: any) {
    console.warn('[Supabase ws_watchlist List Exception]', e?.message || e);
    return [];
  }
}

export async function addToWsWatchlist(symbol: string, name?: string): Promise<boolean> {
  const client = getSupabaseAdmin();
  if (!client || !symbol) return false;
  try {
    const { error } = await client.from('ws_watchlist').upsert({ symbol, name: name || null }, { onConflict: 'symbol' });
    if (error) {
      console.warn('[Supabase ws_watchlist Add Error]', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[Supabase ws_watchlist Add Exception]', e?.message || e);
    return false;
  }
}

export async function removeFromWsWatchlist(symbol: string): Promise<boolean> {
  const client = getSupabaseAdmin();
  if (!client || !symbol) return false;
  try {
    const { error } = await client.from('ws_watchlist').delete().eq('symbol', symbol);
    if (error) {
      console.warn('[Supabase ws_watchlist Remove Error]', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[Supabase ws_watchlist Remove Exception]', e?.message || e);
    return false;
  }
}

// ============================================================================
// 🎯 [기능 추가 - 사용자 요청: "발굴 장마감" 탭] 매 거래일 14:30(KST) 크론이 계산한 그날의 발굴
// 후보군 스냅샷을 영구 저장한다. raw_daily_data(장마감 확정치)와 달리 장마감 "직전" 잠정 데이터라
// 별도 테이블(discovery_snapshots, scratch/create_discovery_snapshots_table.sql)로 분리했다.
// ============================================================================
export interface DiscoverySnapshotRecord {
  date: string;
  symbol: string;
  name: string;
  market: string;
  current_price: number;
  change_rate: number;
  absorption_direction?: string;
  absorption_badge?: string;
  afternoon_volume_ratio_pct?: number;
  volume_surge_ratio?: number;
  pullback_from_high_pct?: number;
  relative_strength_pct?: number;
  discovery_score?: number;
  rank?: number;
}

export async function saveDiscoverySnapshots(records: DiscoverySnapshotRecord[]): Promise<boolean> {
  if (!records || records.length === 0) return false;
  const client = getSupabaseAdmin();
  if (!client) return false;
  const date = records[0].date;
  try {
    // 🚨 [버그 수정 - 실측으로 발견] upsert만 쓰면 "이번 회차엔 후보에서 빠진 종목"(예: 수급 필터로
    // 걸러진 종목)의 지난 회차 행이 그대로 남는다 - 같은 날짜에 크론이 두 번 이상 돈 경우(재시도,
    // 수동 재계산 등) 오래된 종목이 최신 결과와 섞여 순위가 중복되는 게 확인됐다. 저장 전에 그 날짜
    // 행을 전부 지우고 이번 회차 결과로 다시 채워서, 그날의 스냅샷이 항상 "이번 계산 결과 그대로"가
    // 되도록 멱등성을 보장한다.
    const { error: deleteError } = await client.from('discovery_snapshots').delete().eq('date', date);
    if (deleteError) {
      console.warn('[Supabase discovery_snapshots Delete Error]', deleteError.message);
    }

    const { error } = await client
      .from('discovery_snapshots')
      .upsert(records, { onConflict: 'date,symbol' });
    if (error) {
      console.warn('[Supabase discovery_snapshots Save Error]', error.message);
      return false;
    }
    console.log(`[Supabase discovery_snapshots Save] ${date} 발굴 장마감 스냅샷 ${records.length}건 저장 완료(기존 행 삭제 후 재적재)`);
    return true;
  } catch (e: any) {
    console.error('[Supabase discovery_snapshots Save Exception]', e?.message || e);
    return false;
  }
}

export async function fetchDiscoverySnapshots(date: string): Promise<DiscoverySnapshotRecord[]> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client || !date) return [];
  try {
    const { data, error } = await client
      .from('discovery_snapshots')
      .select('*')
      .eq('date', date)
      .order('rank', { ascending: true });
    if (error) {
      console.warn('[Supabase discovery_snapshots List Error]', error.message);
      return [];
    }
    return data || [];
  } catch (e: any) {
    console.warn('[Supabase discovery_snapshots List Exception]', e?.message || e);
    return [];
  }
}

// ============================================================================
// 🎯 [기능 추가 - 사용자 요청: "전조 장마감" 탭] discovery_snapshots와 동일한 이유(장마감 "직전" 잠정
// 데이터라 raw_daily_data와 별도)로 분리한 테이블(precursor_snapshots,
// scratch/create_precursor_snapshots_table.sql). 저장/조회 패턴도 100% 동일하게 재사용한다(수칙 1-6).
// ============================================================================
export interface PrecursorSnapshotRecord {
  date: string;
  symbol: string;
  name: string;
  market: string;
  current_price: number;
  change_rate: number;
  recent_return_pct?: number;
  volume_surge_ratio?: number;
  volume_trend_increasing?: boolean;
  price_volume_divergence?: number;
  close_to_high_ratio_pct?: number;
  precursor_score?: number;
  rank?: number;
}

export async function savePrecursorSnapshots(records: PrecursorSnapshotRecord[]): Promise<boolean> {
  if (!records || records.length === 0) return false;
  const client = getSupabaseAdmin();
  if (!client) return false;
  const date = records[0].date;
  try {
    const { error: deleteError } = await client.from('precursor_snapshots').delete().eq('date', date);
    if (deleteError) {
      console.warn('[Supabase precursor_snapshots Delete Error]', deleteError.message);
    }

    const { error } = await client
      .from('precursor_snapshots')
      .upsert(records, { onConflict: 'date,symbol' });
    if (error) {
      console.warn('[Supabase precursor_snapshots Save Error]', error.message);
      return false;
    }
    console.log(`[Supabase precursor_snapshots Save] ${date} 전조 장마감 스냅샷 ${records.length}건 저장 완료(기존 행 삭제 후 재적재)`);
    return true;
  } catch (e: any) {
    console.error('[Supabase precursor_snapshots Save Exception]', e?.message || e);
    return false;
  }
}

export async function fetchPrecursorSnapshots(date: string): Promise<PrecursorSnapshotRecord[]> {
  const client = getSupabaseAdmin() || getSupabasePublic();
  if (!client || !date) return [];
  try {
    const { data, error } = await client
      .from('precursor_snapshots')
      .select('*')
      .eq('date', date)
      .order('rank', { ascending: true });
    if (error) {
      console.warn('[Supabase precursor_snapshots List Error]', error.message);
      return [];
    }
    return data || [];
  } catch (e: any) {
    console.warn('[Supabase precursor_snapshots List Exception]', e?.message || e);
    return [];
  }
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
  // 🚨 [버그 수정] 원래 이 select에 가격 컬럼이 빠져 있어서, 이 row를 쓰는 fetchTrendPair(kisApi.ts)가
  // 과거 날짜의 closePrice를 항상 0으로 채울 수밖에 없었다. 그 결과 computeStatusBadgeFromTrend가
  // closePrice>0 필터에서 과거 데이터를 전부 걸러내 ma5/ma20/ma60이 항상 null이 되고, 배지가 항상
  // "이평선 수렴"으로 고정되는 구조적 버그로 이어졌다(랭킹 목록과 종목 상세 차트의 배지 불일치의 근본 원인).
  close_price: number;
  open_price?: number;
  high_price?: number;
  low_price?: number;
  volume?: number;
  change_rate?: number;
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

  // 🚨 [버그 수정] Supabase(PostgREST)는 .limit()을 아무리 크게 줘도 프로젝트 기본 응답 상한(보통
  // 1000행)을 넘길 수 없다 - 실측: 295종목 × 20일 = 5,900행이 필요한데 1,000행에서 잘려 최근
  // 3~4일치만 조회됐고, 그 결과 2/3일연속 계산의 trend가 ma20을 계산할 20일치를 못 채워 배지가
  // 항상 "이평선 수렴"으로 나오는 문제로 이어졌다(사용자 실측: 차트 상세 "단기과열" vs 랭킹 목록
  // "이평선 수렴" 불일치, raw_daily_data 백필을 20일치로 넉넉히 늘려도 재현됨 - Supabase 직접
  // 쿼리로 원인 확정). .range()로 페이지를 나눠 필요한 만큼 전부 끌어온다.
  // 🚨 [2차 재발 - 버그 수정] 90일치로 늘린 뒤에도 여전히 일부 종목(리노공업 등)만 "이평선 수렴"에
  // 갇혀있었다 - 원인은 maxPages=20(=20,000행 상한)이었다. 90일 × 295종목 ≈ 26,550행이 필요한데
  // 20,000행에서 잘렸고, 이 쿼리엔 order()도 없어 어떤 종목/날짜가 잘릴지 예측조차 불가능했다
  // (Supabase 프로젝트 콘솔에서 raw_daily_data 실제 행을 직접 대조해 확정: 리노공업은 DB에 90행이
  // 전부 있는데도 API 응답만 틀렸던 게 이 페이지네이션 절단 때문이었다). 여유있게 60으로 늘린다
  // (60,000행 - 300종목 × 120일까지 커버 가능한 상한이라 향후 lookback을 더 늘려도 안전).
  const fetchAllPages = async (
    build: (from: number, to: number) => any,
    pageSize: number = 1000,
    maxPages: number = 60
  ): Promise<any[]> => {
    const all: any[] = [];
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize;
      const { data, error } = await build(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
    }
    return all;
  };

  try {
    // 1. beforeDate 이전에 실제로 기록된 distinct 날짜 중 최근 tradingDaysBack개를 찾는다.
    const dateRows = await fetchAllPages((from, to) =>
      client
        .from('raw_daily_data')
        .select('date')
        .lt('date', beforeDate)
        .order('date', { ascending: false })
        .range(from, to)
    );

    const distinctDates = [...new Set(dateRows.map((r: any) => r.date as string))]
      .sort()
      .reverse()
      .slice(0, tradingDaysBack)
      .sort();

    if (distinctDates.length === 0) return { dates: [], bySymbol: new Map() };

    const data = await fetchAllPages((from, to) =>
      client
        .from('raw_daily_data')
        .select('date, symbol, foreign_net_buy_amt, organ_net_buy_amt, program_net_buy_amt, close_price, open_price, high_price, low_price, volume, change_rate')
        .in('date', distinctDates)
        .range(from, to)
    );

    if (!data) return { dates: distinctDates, bySymbol: new Map() };

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

// ============================================================================
// 🏷️ [사용자 지적 - "그걸 어떻게 고치지"] watch_signal_state: VWAP/피봇 재돌파 감시가 하루 동안
// 쌓는 "오늘 이 선을 한 번이라도 뚫은 적 있음"류 플래그(computeVwapWatchSignal의 hasBeenBelow/
// crossCount, computePivotReclaimSignal의 r1/r2 hasBroken/hasBeenBelowAfterBreak)를 영구
// 저장한다. globalThis(Node 프로세스 메모리)에만 있으면 로컬 dev 재시작은 물론, Vercel
// 서버리스 인스턴스가 폴링 요청마다 다르게 뜰 수 있는 배포 환경에서 통째로 날아간다 -
// shared_rank_cache와 동일한 이유(수칙 1-6)로 이중 저장한다.
// 쓰기는 플래그가 "실제로 바뀐 순간"에만 fire-and-forget으로 호출한다(매 15초 폴링마다 쓰지
// 않음 - 대부분의 폴링은 플래그가 안 바뀌므로 쓰기 비용이 거의 들지 않는다).
// ============================================================================

export interface WatchSignalStateRow {
  vwapHasBeenBelow: boolean;
  vwapCrossCount: number;
  pivotR1HasBroken: boolean;
  pivotR1HasBeenBelowAfterBreak: boolean;
  pivotR2HasBroken: boolean;
  pivotR2HasBeenBelowAfterBreak: boolean;
}

/**
 * 프로세스가 새로 뜬 직후(재시작/콜드스타트) 이 심볼을 아직 한 번도 감시 안 한 시점에만 호출된다 -
 * 심볼당 프로세스 수명 동안 한 번만 조회하면 되므로(그 뒤로는 인메모리 맵에 이미 있음) 매 폴링마다
 * 발생하는 비용이 아니다.
 */
export async function fetchWatchSignalState(date: string, symbol: string): Promise<WatchSignalStateRow | null> {
  const client = getSupabaseAdmin();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('watch_signal_state')
      .select('vwap_has_been_below, vwap_cross_count, pivot_r1_has_broken, pivot_r1_has_been_below_after_break, pivot_r2_has_broken, pivot_r2_has_been_below_after_break')
      .eq('date', date)
      .eq('symbol', symbol)
      .maybeSingle();

    if (error || !data) return null;
    return {
      vwapHasBeenBelow: !!data.vwap_has_been_below,
      vwapCrossCount: data.vwap_cross_count || 0,
      pivotR1HasBroken: !!data.pivot_r1_has_broken,
      pivotR1HasBeenBelowAfterBreak: !!data.pivot_r1_has_been_below_after_break,
      pivotR2HasBroken: !!data.pivot_r2_has_broken,
      pivotR2HasBeenBelowAfterBreak: !!data.pivot_r2_has_been_below_after_break,
    };
  } catch (e: any) {
    console.warn('[Supabase watch_signal_state Read Exception]', e?.message || e);
    return null;
  }
}

/**
 * partial에 담긴 필드만 upsert한다 - VWAP 쪽 함수와 피봇 쪽 함수가 서로 다른 시점에 독립적으로
 * 호출해도(수칙 1-6, 두 기능이 한 테이블을 공유) onConflict로 병합되므로 상대방이 이미 저장해둔
 * 플래그를 덮어써 지우지 않는다.
 */
export async function upsertWatchSignalState(date: string, symbol: string, partial: Partial<WatchSignalStateRow>): Promise<void> {
  const client = getSupabaseAdmin();
  if (!client) return;

  try {
    const row: Record<string, any> = { date, symbol, updated_at: new Date().toISOString() };
    if (partial.vwapHasBeenBelow !== undefined) row.vwap_has_been_below = partial.vwapHasBeenBelow;
    if (partial.vwapCrossCount !== undefined) row.vwap_cross_count = partial.vwapCrossCount;
    if (partial.pivotR1HasBroken !== undefined) row.pivot_r1_has_broken = partial.pivotR1HasBroken;
    if (partial.pivotR1HasBeenBelowAfterBreak !== undefined) row.pivot_r1_has_been_below_after_break = partial.pivotR1HasBeenBelowAfterBreak;
    if (partial.pivotR2HasBroken !== undefined) row.pivot_r2_has_broken = partial.pivotR2HasBroken;
    if (partial.pivotR2HasBeenBelowAfterBreak !== undefined) row.pivot_r2_has_been_below_after_break = partial.pivotR2HasBeenBelowAfterBreak;

    const { error } = await client
      .from('watch_signal_state')
      .upsert(row, { onConflict: 'date,symbol' });
    if (error) {
      console.warn('[Supabase watch_signal_state Upsert Error]', error.message);
    }
  } catch (e: any) {
    console.warn('[Supabase watch_signal_state Upsert Exception]', e?.message || e);
  }
}

/**
 * 🎯 [기능 추가 - 사용자 요청: "테이블기록 만들자", "매수/매도 비율을 너무 빡세게 고정하지 않는 것도
 * 중요. 과거 데이터를 돌려서 임계값을 찾는 게 낫겠어"] "재돌파 임박" 판정이 매수 우위로 확정되거나
 * (approaching) 매도 우위로 제외되는(sell_pressure) 순간의 매수/매도 거래량을 기록한다 - 나중에
 * 실제 다음날/다음 며칠 결과와 대조해서 지금의 "단순 과반" 임계값을 데이터 기반으로 조정할 수 있게
 * 하는 1단계(수집) 저장이다. rising edge(그 상태로 막 전환된 순간)에만 호출되므로 매 15초 폴링마다
 * 쌓이지 않는다(호출부인 kisApi.ts에서 이미 전환 감지를 마치고 부른다). fire-and-forget.
 */
export async function logReclaimSignalEvent(params: {
  date: string;
  symbol: string;
  levelType: 'vwap' | 'r1' | 'r2';
  eventType: 'approaching' | 'sell_pressure';
  price: number;
  target: number;
  buyVolume: number;
  sellVolume: number;
  // 🎯 [기능 추가 - 사용자 요청: "절대 활성도 게이트는 임의로 숫자 박지 말고, 현재 rate / baseline rate /
  // 오늘 평균 rate를 전부 로깅해서 데이터 쌓은 뒤 임계값을 정하자"] 판정에는 아직 쓰지 않고 기록만 한다.
  recentRate: number | null;
  baselineRate: number | null;
  todayAvgRate: number | null;
}): Promise<number | null> {
  const client = getSupabaseAdmin();
  if (!client) return null;

  try {
    // 🎯 [기능 추가 - 사용자 요청: "approaching이 나중에 실제 재돌파 성공으로 이어졌는지 outcome을 기록
    // 하자"] insert된 행의 id를 돌려줘야 falling edge(approaching이 꺼지는 순간)에 같은 행을 찾아
    // updateReclaimSignalOutcome으로 결과를 채워 넣을 수 있다 - sell_pressure 이벤트는 outcome 대상이
    // 아니므로(사용자 요청 범위 밖) 호출부에서 approaching 이벤트일 때만 이 id를 기억해둔다.
    const { data, error } = await client
      .from('reclaim_signal_events')
      .insert({
        date: params.date,
        symbol: params.symbol,
        level_type: params.levelType,
        event_type: params.eventType,
        price: params.price,
        target: params.target,
        buy_volume: params.buyVolume,
        sell_volume: params.sellVolume,
        recent_rate: params.recentRate,
        baseline_rate: params.baselineRate,
        today_avg_rate: params.todayAvgRate,
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[Supabase reclaim_signal_events Insert Error]', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e: any) {
    console.warn('[Supabase reclaim_signal_events Insert Exception]', e?.message || e);
    return null;
  }
}

/**
 * approaching으로 기록됐던 행이 나중에 실제 재돌파 성공(success)으로 이어졌는지, 힘이 빠져 실패
 * (failed)했는지를 falling edge 시점에 채워 넣는다. 별도 대기시간(매직넘버) 없이, "approaching이
 * 꺼지는 바로 그 순간 가격이 기준선 위에 있었는가"로만 판정한다(호출부 kisApi.ts 참고) - approaching은
 * 정의상 가격이 기준선을 넘는 순간(stillBelow=false) 즉시 꺼지므로, 이 판정이 자연스럽게 "그 approaching
 * 시도가 실제 돌파로 이어졌는지"와 일치한다. fire-and-forget.
 */
export async function updateReclaimSignalOutcome(id: number, outcome: 'success' | 'failed'): Promise<void> {
  const client = getSupabaseAdmin();
  if (!client) return;

  try {
    const { error } = await client.from('reclaim_signal_events').update({ outcome }).eq('id', id);
    if (error) {
      console.warn('[Supabase reclaim_signal_events Outcome Update Error]', error.message);
    }
  } catch (e: any) {
    console.warn('[Supabase reclaim_signal_events Outcome Update Exception]', e?.message || e);
  }
}

