// [오라클 서버 상시 실행] 프로그램매매 300종목 주기 수집기.
// 사용자 결정(2026-09-23): 프로그램매매 300종목(TOP_300) 전체를 장중 약 2~3분 주기로 KIS REST로 수집해 Supabase
// 캐시(shared_rank_cache 'full:program_*')에 저장하고, 웹은 KIS를 직접 부르지 않고 그 캐시만 읽는다.
//  - 수집 로직은 사이트와 "같은 코드"(src/lib/batchCollector.ts runTop50BatchCollector)를 그대로 불러 쓴다(수칙 1-6).
//    따로 짜면 사이트 계산(폴백·배지 보정·1d/1w/1m 순위 생성)과 어긋날 위험이 있어서다.
//  - KIS 초당 한도(이 앱키 실측 5건/초)를 사이트와 나눠 쓰므로 이 프로세스만 호출 간격을 400ms(2.5건/초)로 넓힌다.
//  - 평일 08:00~20:10 KST만 수집(NXT 프리마켓~애프터마켓 20:00 마감값까지). 휴장일(CTCA0903R opnd_yn=N)엔 쉰다.
//  - 매 회차 결과를 cron_run_logs(cron='oracle-program-collector')에 남긴다 - 살아있는지(heartbeat) 확인용.
//
// 실행: node scripts/program-collector.js [--once]
//   --once: 한 회차만 돌고 종료(로컬 검증용). 없으면 무한 루프(systemd 서비스로 상시 실행).
// 환경변수: 작업 폴더의 .env(오라클) 또는 .env.local(로컬)에서 KIS_APPKEY, KIS_APPSECRET, NEXT_PUBLIC_SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY를 읽는다(ws-bridge와 같은 이름).
const fs = require('fs');
const path = require('path');

// ── 환경변수 로드 (반드시 src/lib를 불러오기 전에 - kisApi.ts가 모듈 로드 시점에 호출 간격을 읽는다) ──
for (const envFile of ['.env', '.env.local']) {
  const p = path.join(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, 'utf8').split('\n').forEach((line) => {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length && !k.startsWith('#') && process.env[k.trim()] === undefined) {
      process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
    }
  });
}
process.env.KIS_QUEUE_MIN_DELAY_MS = process.env.KIS_QUEUE_MIN_DELAY_MS || '400';
process.env.KIS_MIN_CALL_INTERVAL_MS = process.env.KIS_MIN_CALL_INTERVAL_MS || '400';

require('./lib/tsRequire').registerTsRequire();
const { isKrxOpenDay, kstNow } = require('./lib/kisHoliday');
const { runTop50BatchCollector, getBatchRankingData } = require('../src/lib/batchCollector.ts');
const { getKisAccessToken } = require('../src/lib/kisApi.ts');
const { getSupabaseAdmin } = require('../src/lib/supabase.ts');

const CYCLE_MS = 150 * 1000; // 회차 시작 간격 2.5분(수집 자체가 약 2분이라 실제 갱신 주기는 2~3분)
const MIN_GAP_MS = 15 * 1000; // 수집이 길어져도 회차 사이 최소 휴식
const ACTIVE_FROM = 800; // KST 08:00
const ACTIVE_UNTIL = 2010; // KST 20:10 (20:00 애프터마켓 마감값까지 한 번 더 잡는다)
const ONCE = process.argv.includes('--once');
const CRON_NAME = 'oracle-program-collector';

const log = (...args) => console.log(`[${kstNow().text} KST]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logRun(fields) {
  const client = getSupabaseAdmin();
  if (!client) return;
  try {
    const { error } = await client.from('cron_run_logs').insert({ cron: CRON_NAME, user_agent: 'oracle-program-collector', ...fields });
    if (error) log('[cron_run_logs 기록 실패]', error.message);
  } catch (e) {
    log('[cron_run_logs 기록 예외]', e.message || e);
  }
}

async function isOpenToday(ymd) {
  const token = await getKisAccessToken();
  if (!token) throw new Error('KIS 토큰 없음(Supabase 공유 토큰 - 사이트 refresh-kis-token 크론이 발급)');
  return isKrxOpenDay(ymd, { token, appKey: process.env.KIS_APPKEY.trim(), appSecret: process.env.KIS_APPSECRET.trim() });
}

async function runOneCycle() {
  const startedAt = new Date();
  const t0 = Date.now();
  try {
    const ok = await runTop50BatchCollector(true, 'oracle_program', true, false);
    const count = getBatchRankingData('program', 'buy', '1d', 'ALL').list.length;
    const elapsed = Date.now() - t0;
    log(`수집 ${ok ? '완료' : '실패'}: ${count}종목, ${(elapsed / 1000).toFixed(1)}초`);
    await logRun({
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      status: ok && count > 0 ? 'ok' : ok ? 'empty' : 'error',
      http_status: null,
      count,
      saved: ok && count > 0,
      elapsed_ms: elapsed,
      error: ok ? null : 'runTop50BatchCollector가 false 반환',
    });
  } catch (e) {
    const elapsed = Date.now() - t0;
    log('[수집 예외]', e.message || e);
    await logRun({ started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), status: 'error', count: null, saved: false, elapsed_ms: elapsed, error: String(e.message || e).slice(0, 500) });
  }
}

async function main() {
  log(`프로그램매매 수집기 시작 (KIS 호출 간격 ${process.env.KIS_QUEUE_MIN_DELAY_MS}ms, 회차 간격 ${CYCLE_MS / 1000}초, ${ONCE ? '1회만' : '상시'})`);
  if (ONCE) {
    await runOneCycle();
    return;
  }
  let lastCheckedDay = null;
  let openToday = false;
  for (;;) {
    const now = kstNow();
    const inWindow = now.dow >= 1 && now.dow <= 5 && now.hhmm >= ACTIVE_FROM && now.hhmm < ACTIVE_UNTIL;
    if (!inWindow) {
      await sleep(60 * 1000);
      continue;
    }
    if (lastCheckedDay !== now.ymd) {
      try {
        openToday = await isOpenToday(now.ymd);
        lastCheckedDay = now.ymd;
        log(`오늘(${now.ymd}) ${openToday ? '개장일 - 수집 시작' : '휴장일 - 오늘은 수집하지 않음'}`);
      } catch (e) {
        log('[휴장일 확인 실패 - 5분 뒤 재시도]', e.message || e);
        await sleep(5 * 60 * 1000);
        continue;
      }
    }
    if (!openToday) {
      await sleep(10 * 60 * 1000);
      continue;
    }
    const cycleStart = Date.now();
    await runOneCycle();
    const spent = Date.now() - cycleStart;
    await sleep(Math.max(CYCLE_MS - spent, MIN_GAP_MS));
  }
}

main().catch((e) => {
  log('[치명적 오류 - 프로세스 종료, systemd가 재시작]', e);
  process.exit(1);
});
