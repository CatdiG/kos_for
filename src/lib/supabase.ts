import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabasePublicClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
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
  const client = getSupabasePublic() || getSupabaseAdmin();
  if (!client) {
    console.warn('[Supabase Warning] SUPABASE_URL 또는 KEY가 설정되지 않아 DB 조회를 건너땁니다.');
    return null;
  }

  try {
    const { data, error } = await client
      .from('kis_tokens')
      .select('access_token, expires_at, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      console.error('[Supabase DB Read Error]', error.message);
      return null;
    }

    if (data && data.access_token) {
      const expiresAtMs = new Date(data.expires_at).getTime();
      return {
        access_token: data.access_token,
        expires_at: expiresAtMs,
        updated_at: data.updated_at,
      };
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
