// 크론 실행 기록 공통 래퍼 - /api/cron/* 8개 라우트가 똑같이 쓴다(수칙 1-6).
// 🎯 [기능 추가 - 사용자 요청 2026-09-23] precursor_snapshots에 9/18~9/22 기록이 없었는데 "후보 0개라 저장을
// 건너뜀(savePrecursorSnapshots가 0건이면 조용히 false)"인지 "실패/미실행"인지 Vercel 로그 없이 구분할 수
// 없었다. 또 Vercel 크론이 예약보다 늦게 도는 정황(발굴 14:30 예약 → 15:12 저장)을 검증할 실제 실행 시각도
// 남지 않았다. 그래서 크론마다 시작 시 'running' 행을 넣고, 끝나면 응답 내용으로 결과를 갱신한다.
//  - 'running'으로 남은 행 = 시간초과 강제종료 등으로 끝을 못 본 실행
//  - 401(인증 실패)은 기록하지 않는다 - 외부 무작위 호출로 기록이 쌓이지 않게.
//  - 기록 실패가 크론 본 작업을 막으면 안 되므로 기록 오류는 console.warn으로만 남긴다(작업 결과는 그대로 반환).
// 테이블: scratch/create_cron_run_logs_table.sql
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from './supabase';

type CronRunStatus = 'running' | 'ok' | 'empty' | 'save_failed' | 'error';

function sanitizeQuery(request: NextRequest): string | null {
  const url = new URL(request.url);
  url.searchParams.delete('secret'); // 인증 값은 기록하지 않는다
  const q = url.searchParams.toString();
  return q || null;
}

// started_at은 DB 시계(now())로 찍히므로, finished_at도 같은 시계 기준이 되도록 "DB 시작 시각 + 앱이 잰 경과시간"으로
// 계산한다. 처음엔 finished_at을 앱 서버 시계(new Date())로 넣었더니 로컬 실측에서 PC 시계가 DB보다 1.2초 느려
// finished_at이 started_at보다 앞서는 역전이 생겼다 - 지연 측정용 기록이라 한 시계로 통일한다.
async function insertRunning(cron: string, request: NextRequest): Promise<{ id: number; startedAtMs: number } | null> {
  const client = getSupabaseAdmin();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('cron_run_logs')
      .insert({
        cron,
        query: sanitizeQuery(request),
        user_agent: (request.headers.get('user-agent') || '').slice(0, 200) || null,
        status: 'running' as CronRunStatus,
      })
      .select('id, started_at')
      .single();
    if (error) {
      console.warn(`[cron_run_logs 시작 기록 실패] ${cron}: ${error.message}`);
      return null;
    }
    const row = data as { id: number; started_at: string };
    return { id: row.id, startedAtMs: Date.parse(row.started_at) };
  } catch (e) {
    console.warn(`[cron_run_logs 시작 기록 예외] ${cron}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function updateFinished(
  run: { id: number; startedAtMs: number },
  cron: string,
  fields: { status: CronRunStatus; http_status: number; count: number | null; saved: boolean | null; elapsed_ms: number; error: string | null }
): Promise<void> {
  const client = getSupabaseAdmin();
  if (!client) return;
  try {
    const { error } = await client
      .from('cron_run_logs')
      .update({ ...fields, finished_at: new Date(run.startedAtMs + fields.elapsed_ms).toISOString() })
      .eq('id', run.id);
    if (error) console.warn(`[cron_run_logs 종료 기록 실패] ${cron}: ${error.message}`);
  } catch (e) {
    console.warn(`[cron_run_logs 종료 기록 예외] ${cron}:`, e instanceof Error ? e.message : e);
  }
}

/** 응답(JSON 본문)으로 실행 결과 상태를 판정한다. */
function classify(httpStatus: number, body: Record<string, unknown> | null): { status: CronRunStatus; count: number | null; saved: boolean | null; error: string | null } {
  const count = typeof body?.count === 'number' ? (body.count as number) : null;
  const saved = typeof body?.saved === 'boolean' ? (body.saved as boolean) : null;
  const errText = typeof body?.error === 'string' ? (body.error as string) : null;
  if (httpStatus >= 400) return { status: 'error', count, saved, error: errText || `HTTP ${httpStatus}` };
  if (count === 0) return { status: 'empty', count, saved, error: null };
  if (saved === false) return { status: 'save_failed', count, saved, error: errText };
  return { status: 'ok', count, saved, error: null };
}

/**
 * 크론 핸들러를 감싸 실행 기록을 남긴다. 인증 거부(401)는 각 라우트 핸들러가 기존대로 처리한다.
 * 'running' 시작 행은 핸들러 실행 "전"에 넣어야 강제종료도 잡히는데, 그 시점엔 핸들러의 인증 결과를 모르므로
 * 아래 isAuthorizedCronRequest로 같은 기준을 미리 한 번 확인해 인증된 요청만 기록한다.
 */
export async function withCronRunLog(
  cron: string,
  request: NextRequest,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const startedAt = Date.now();
  const run = isAuthorizedCronRequest(request) ? await insertRunning(cron, request) : null;

  let response: NextResponse;
  try {
    response = await handler();
  } catch (e) {
    // 각 라우트는 자체 try/catch로 500을 돌려주지만, 그 바깥에서 난 예외도 기록하고 500으로 응답한다
    const message = e instanceof Error ? e.message : String(e);
    if (run !== null) {
      await updateFinished(run, cron, { status: 'error', http_status: 500, count: null, saved: null, elapsed_ms: Date.now() - startedAt, error: message });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (run !== null) {
    let body: Record<string, unknown> | null = null;
    try {
      body = await response.clone().json();
    } catch {
      body = null; // JSON이 아닌 응답 - 상태 코드만으로 판정
    }
    const c = classify(response.status, body);
    await updateFinished(run, cron, { ...c, http_status: response.status, elapsed_ms: Date.now() - startedAt });
  }
  return response;
}

/**
 * 각 크론 라우트와 같은 기준(CRON_SECRET: Authorization Bearer 또는 ?secret=)으로 인증 여부만 판별.
 * 라우트마다 있는 인증 코드와 중복이지만, 실제 거부는 라우트가 하고 여기선 "기록할지"만 정하는 용도라
 * 라우트 인증 로직은 건드리지 않는다(8개 라우트 동작 변경 없이 기록만 추가 - 수칙 1-6 중복 사유).
 */
function isAuthorizedCronRequest(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  const authHeader = request.headers.get('authorization');
  const secretParam = new URL(request.url).searchParams.get('secret');
  return authHeader === `Bearer ${cronSecret}` || secretParam === cronSecret;
}
