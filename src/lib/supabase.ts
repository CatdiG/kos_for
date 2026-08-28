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

export interface RawDailyInvestorRecord {
  date: string; // YYYYMMDD (e.g. '20260827')
  symbol: string; // '005930'
  name: string; // '삼성전자'
  close_price: number;
  volume: number;
  change_rate?: number;
  foreign_net_buy_qty: number;
  foreign_net_buy_amt: number;
  organ_net_buy_qty: number;
  organ_net_buy_amt: number;
  pension_net_buy_qty: number;
  pension_net_buy_amt: number;
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
  try {
    const fs = require('fs');
    const path = require('path');
    const targetDate = records[0]?.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(process.cwd(), 'scratch', 'raw_daily_data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${targetDate}.json`);
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    console.log(`[Raw Data File Saved] 원본 데이터 로컬 적재 완료: ${filePath} (${records.length}개 종목)`);
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
      volume: r.volume,
      change_rate: r.change_rate || 0,
      foreign_net_buy_qty: r.foreign_net_buy_qty || 0,
      foreign_net_buy_amt: r.foreign_net_buy_amt || 0,
      organ_net_buy_qty: r.organ_net_buy_qty || 0,
      organ_net_buy_amt: r.organ_net_buy_amt || 0,
      pension_net_buy_qty: r.pension_net_buy_qty || 0,
      pension_net_buy_amt: r.pension_net_buy_amt || 0,
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


