'use client';

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// 🎯 [기능 추가 - 사용자 요청: "관심종목 웹소캣으로 실시간 된다는거 아니였어? 안되는데" - "그거 실행하자"]
// 브라우저에서 Supabase Realtime(Postgres 변경 스트림)을 직접 구독하기 위한 전용 클라이언트다.
// src/lib/supabase.ts(서버 전용, SERVICE_ROLE_KEY 포함)를 그대로 클라이언트 번들에 끌어오면 admin
// 관련 코드까지 브라우저로 새어 나갈 위험이 있어, anon key만 쓰는 최소 클라이언트를 따로 둔다.
let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (browserClient) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  browserClient = createClient(url, key, { auth: { persistSession: false } });
  return browserClient;
}
