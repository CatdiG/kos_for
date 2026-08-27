import { NextRequest, NextResponse } from 'next/server';
import { saveTokenToSupabase } from '@/lib/supabase';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TOKEN_CACHE_KEY = Symbol.for('kis_token_cache_v2');
const LOCAL_TOKEN_FILE = path.join(process.cwd(), 'scratch', '.kis_token_cache.json');

export async function GET(request: NextRequest) {
  return handleCronTokenRefresh(request);
}

export async function POST(request: NextRequest) {
  return handleCronTokenRefresh(request);
}

async function handleCronTokenRefresh(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');

  // Strict Vercel Cron Header / CRON_SECRET authorization check
  if (!cronSecret || cronSecret.trim() === '') {
    console.warn('[Cron Auth Error] CRON_SECRET 미설정으로 인한 토큰 갱신 실행 거부');
    return NextResponse.json({ error: 'Unauthorized: CRON_SECRET not configured' }, { status: 401 });
  }

  const expectedBearer = `Bearer ${cronSecret.trim()}`;
  const isHeaderValid = authHeader === expectedBearer;
  const isParamValid = secretParam === cronSecret.trim();

  if (!isHeaderValid && !isParamValid) {
    console.warn('[Cron Auth Rejected] CRON_SECRET 인증 실패');
    return NextResponse.json({ error: 'Unauthorized: Invalid CRON_SECRET' }, { status: 401 });
  }

  const rawKey = process.env.KIS_APPKEY || '';
  const rawSecret = process.env.KIS_APPSECRET || '';
  const appKey = rawKey.trim().replace(/^["']|["']$/g, '');
  const appSecret = rawSecret.trim().replace(/^["']|["']$/g, '');
  const isVirtual = process.env.KIS_VIRTUAL === 'true';

  if (!appKey || !appSecret) {
    return NextResponse.json(
      { error: 'KIS_APPKEY 또는 KIS_APPSECRET이 설정되지 않았습니다.' },
      { status: 500 }
    );
  }

  const defaultBaseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:29443'
    : 'https://openapi.koreainvestment.com:9443';
  const baseUrl = process.env.KIS_BASE_URL || defaultBaseUrl;

  try {
    console.log('[TOKEN-ISSUE-TRACE:START]', new Date().toISOString(), new Error().stack);
    console.log('[Vercel Cron KIS Token] KIS OpenAPI 서버로 신규 토큰 발급 요청 중...');
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
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Cron KIS OAuth Error ${res.status}]`, errorText);
      return NextResponse.json(
        { error: `KIS OAuth Error ${res.status}: ${errorText}` },
        { status: 500 }
      );
    }

    const data: any = await res.json();
    if (data && data.access_token) {
      console.log('[TOKEN-ISSUE-TRACE:FETCH-SUCCESS]', new Date().toISOString(), `Access Token received (Length: ${data.access_token.length})`);
      const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : parseInt(data.expires_in || '86400', 10);
      const expiresAt = Date.now() + expiresInSec * 1000;
      const appKeyHash = `${appKey.slice(0, 6)}_${isVirtual ? 'vts' : 'real'}`;

      const tokenCache = {
        access_token: data.access_token,
        expires_at: expiresAt,
        app_key_hash: appKeyHash,
      };

      // 1. Memory Sync
      (globalThis as any)[TOKEN_CACHE_KEY] = tokenCache;

      // 2. Local File Cache Sync
      try {
        const dir = path.dirname(LOCAL_TOKEN_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify(tokenCache), 'utf8');
      } catch (e) {
        console.error('[Cron File Cache Error]', e);
      }

      // 3. Supabase DB Save (id=1 UPSERT)
      const supabaseSaved = await saveTokenToSupabase(data.access_token, expiresAt);
      console.log('[TOKEN-ISSUE-TRACE:SUPABASE-SAVE]', new Date().toISOString(), `Supabase Save Result: ${supabaseSaved ? 'SUCCESS' : 'FAILED'}`);

      console.log(`[Cron Token Refresh Success] 토큰 신규 발급 완료 (Supabase 저장: ${supabaseSaved ? '성공' : '실패'})`);

      return NextResponse.json({
        success: true,
        message: 'KIS API 접근 토큰 발급 및 Supabase 저장 완료',
        expires_at: new Date(expiresAt).toISOString(),
        supabase_saved: supabaseSaved,
      });
    } else {
      const errStr = data?.error_description || data?.msg1 || 'Access token missing in response';
      return NextResponse.json({ error: errStr }, { status: 500 });
    }
  } catch (e: any) {
    console.error('[Cron Exception]', e?.message || e);
    return NextResponse.json({ error: e?.message || e }, { status: 500 });
  }
}
