// [1회성 시험 - 오라클 서버] KIS WebSocket 실시간 프로그램매매(통합) H0UNPGM0 검증.
// 사용자 요청(2026-09-23): "장중에 1~2종목으로 시험. H0UNPGM0의 순매수 체결량/순매수 거래대금이 누적값인지 확인,
// 같은 시각의 REST 누적 프로그램매매 값과 비교, 현재 운영 ws-bridge를 건드리는 테스트는 최소화".
//  - 다음 개장일(KIS 휴장일조회 opnd_yn=Y) 09:05 KST까지 기다렸다가 TEST_MINUTES분만 실행하고 종료한다.
//  - 운영 ws-bridge(H0UNCNT0 상시 구독)는 코드·설정을 전혀 건드리지 않는다. 대신 별도 WebSocket 연결을 잠깐
//    연다 - 같은 앱키로 두 번째 연결을 열 때 ws-bridge가 끊기는지는 공식 자료로 확인하지 못해서(구독 한도
//    41개도 미확인), 실행 시간을 짧게(5분) 제한하고, 연결 이벤트(끊김/오류/제어 메시지)를 모두 기록한다.
//    ws-bridge 영향 여부는 시험 시각의 ws-bridge 로그(journalctl)로 따로 확인한다.
//  - 필드 순서(KIS 공식 예제 program_trade_total.py): 종목코드, 체결시간, 매도체결량, 매도거래대금,
//    매수2체결량, 매수2거래대금, 순매수체결량, 순매수거래대금, 매도호가잔량, 매수호가잔량, 전체순매수호가잔량
//  - 비교 대상 REST: FHPPG04650101(program-trade-by-stock, UN) - 사이트가 쓰는 누적값
//    whol_smtn_ntby_qty / whol_smtn_ntby_tr_pbmn(원 단위, 2026-09-23 실측).
//  - 판정: (a) WS 값 ≈ 같은 시각 REST 누적값이면 "누적", (b) 시험 구간 WS 값의 합 ≈ 같은 구간 REST 누적 증가분이면
//    "체결 1건분(증분)". 결과는 JSON 파일과 cron_run_logs(cron='ws-program-test')에 요약으로 남긴다.
//
// 실행: node scripts/ws_program_trade_test.js [--now]   (--now: 개장 대기 없이 즉시 실행 - 장중 수동 재시험용)
const fs = require('fs');
const path = require('path');

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

require('./lib/tsRequire').registerTsRequire();
const { isKrxOpenDay, kstNow } = require('./lib/kisHoliday');
const { getKisAccessToken } = require('../src/lib/kisApi.ts');
const { getSupabaseAdmin } = require('../src/lib/supabase.ts');

const SYMBOLS = ['005930', '000660'];
const TR_ID = 'H0UNPGM0';
const START_HHMM = 905; // 09:05 KST (장 시작 직후 체결이 충분히 쌓인 뒤)
const TEST_MINUTES = 5;
const REST_POLL_MS = 20 * 1000;
const FIELDS = ['symbol', 'time', 'selnQty', 'selnAmt', 'shnuQty', 'shnuAmt', 'ntbyQty', 'ntbyAmt', 'selnRsqn', 'shnuRsqn', 'wholNtbyRsqn'];
const KIS = 'https://openapi.koreainvestment.com:9443';
const APPKEY = (process.env.KIS_APPKEY || '').trim();
const APPSECRET = (process.env.KIS_APPSECRET || '').trim();
const OUT_DIR = path.join(process.cwd(), 'ws-test-results');

const log = (...a) => console.log(`[${kstNow().text} KST]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForOpenDayStart() {
  for (;;) {
    const now = kstNow();
    if (now.dow >= 1 && now.dow <= 5 && now.hhmm >= START_HHMM && now.hhmm < 1500) {
      const token = await getKisAccessToken();
      if (!token) { log('KIS 토큰 없음 - 5분 뒤 재시도'); await sleep(5 * 60 * 1000); continue; }
      const open = await isKrxOpenDay(now.ymd, { token, appKey: APPKEY, appSecret: APPSECRET }).catch((e) => { log('휴장일 확인 실패:', e.message); return null; });
      if (open === true) return now.ymd;
      if (open === false) { log(`${now.ymd} 휴장일 - 다음 날까지 대기`); await sleep(6 * 60 * 60 * 1000); continue; }
      await sleep(5 * 60 * 1000);
      continue;
    }
    await sleep(60 * 1000);
  }
}

async function restCumulative(symbol, token) {
  const res = await fetch(`${KIS}/uapi/domestic-stock/v1/quotations/program-trade-by-stock?FID_COND_MRKT_DIV_CODE=UN&FID_INPUT_ISCD=${symbol}`, {
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}`, appkey: APPKEY, appsecret: APPSECRET, tr_id: 'FHPPG04650101', custtype: 'P' },
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json();
  const o = Array.isArray(j.output) ? j.output[0] : null;
  if (!o) return { error: `${j.rt_cd} ${j.msg1}` };
  return { restTime: o.bsop_hour, qty: Number(o.whol_smtn_ntby_qty), amt: Number(o.whol_smtn_ntby_tr_pbmn) };
}

async function runTest(ymd) {
  log(`시험 시작: ${TR_ID} ${SYMBOLS.join(', ')} / ${TEST_MINUTES}분`);
  const events = []; // 연결 이벤트·제어 메시지
  const ticks = []; // WS 데이터
  const rest = []; // REST 누적값 스냅샷

  const approvalRes = await fetch(`${KIS}/oauth2/Approval`, {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APPKEY, secretkey: APPSECRET }),
  });
  const approval = await approvalRes.json();
  if (!approval.approval_key) throw new Error(`approval_key 발급 실패: ${JSON.stringify(approval)}`);

  const token = await getKisAccessToken();
  const ws = new WebSocket('ws://ops.koreainvestment.com:21000');
  const endAt = Date.now() + TEST_MINUTES * 60 * 1000;

  ws.addEventListener('open', () => {
    events.push({ at: kstNow().text, type: 'open' });
    for (const s of SYMBOLS) {
      ws.send(JSON.stringify({ header: { approval_key: approval.approval_key, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' }, body: { input: { tr_id: TR_ID, tr_key: s } } }));
    }
  });
  ws.addEventListener('message', (ev) => {
    const raw = String(ev.data);
    if (raw.startsWith('{')) {
      try {
        const p = JSON.parse(raw);
        if (p?.header?.tr_id === 'PINGPONG') { ws.send(raw); return; }
        events.push({ at: kstNow().text, type: 'control', tr_key: p?.header?.tr_key, rt_cd: p?.body?.rt_cd, msg_cd: p?.body?.msg_cd, msg1: p?.body?.msg1 });
      } catch { /* 파싱 불가 제어 메시지는 원문 일부만 */ events.push({ at: kstNow().text, type: 'control-raw', raw: raw.slice(0, 200) }); }
      return;
    }
    const parts = raw.split('|');
    if (parts[1] !== TR_ID) return;
    const count = parseInt(parts[2], 10);
    const f = parts[3].split('^');
    for (let i = 0; i < count; i++) {
      const block = f.slice(i * FIELDS.length, (i + 1) * FIELDS.length);
      const rec = { recvAt: kstNow().text };
      FIELDS.forEach((name, idx) => { rec[name] = idx < 2 ? block[idx] : Number(block[idx]); });
      ticks.push(rec);
    }
  });
  ws.addEventListener('close', (ev) => events.push({ at: kstNow().text, type: 'close', code: ev.code, reason: ev.reason }));
  ws.addEventListener('error', (ev) => events.push({ at: kstNow().text, type: 'error', message: String(ev.message || ev.error || '') }));

  while (Date.now() < endAt) {
    for (const s of SYMBOLS) {
      const r = await restCumulative(s, token).catch((e) => ({ error: e.message }));
      rest.push({ at: kstNow().text, symbol: s, ...r });
      await sleep(300);
    }
    await sleep(REST_POLL_MS);
  }
  for (const s of SYMBOLS) {
    try { ws.send(JSON.stringify({ header: { approval_key: approval.approval_key, custtype: 'P', tr_type: '2', 'content-type': 'utf-8' }, body: { input: { tr_id: TR_ID, tr_key: s } } })); } catch { /* 이미 끊겼으면 무시 */ }
  }
  await sleep(1000);
  ws.close();

  // ── 판정 ──
  const summary = { ymd, trId: TR_ID, symbols: {}, events };
  for (const s of SYMBOLS) {
    const t = ticks.filter((x) => x.symbol === s);
    const r = rest.filter((x) => x.symbol === s && x.amt !== undefined);
    const lastTick = t[t.length - 1];
    const lastRest = r[r.length - 1];
    const firstRest = r[0];
    const wsSumAmt = t.reduce((a, x) => a + (x.ntbyAmt || 0), 0);
    const wsSumQty = t.reduce((a, x) => a + (x.ntbyQty || 0), 0);
    const restDeltaAmt = lastRest && firstRest ? lastRest.amt - firstRest.amt : null;
    const restDeltaQty = lastRest && firstRest ? lastRest.qty - firstRest.qty : null;
    const monotonicShare = t.length > 1 ? t.slice(1).filter((x, i) => x.ntbyQty !== t[i].ntbyQty).length / (t.length - 1) : null;
    summary.symbols[s] = {
      wsTicks: t.length,
      restSnapshots: r.length,
      lastTick: lastTick || null,
      lastRest: lastRest || null,
      // (a) 누적값이라면: 마지막 WS 값 ≈ 마지막 REST 누적값
      lastWsVsRestAmt: lastTick && lastRest ? { ws: lastTick.ntbyAmt, rest: lastRest.amt, diff: lastTick.ntbyAmt - lastRest.amt } : null,
      lastWsVsRestQty: lastTick && lastRest ? { ws: lastTick.ntbyQty, rest: lastRest.qty, diff: lastTick.ntbyQty - lastRest.qty } : null,
      // (b) 체결 1건분(증분)이라면: 구간 WS 합 ≈ 구간 REST 증가분
      windowWsSumVsRestDelta: { wsSumAmt, restDeltaAmt, wsSumQty, restDeltaQty },
      changedTickShare: monotonicShare,
    };
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `ws_program_test_${ymd}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, ticks, rest }, null, 1));
  log(`결과 저장: ${outFile}`);
  log('요약:', JSON.stringify(summary.symbols));

  const client = getSupabaseAdmin();
  if (client) {
    const brief = SYMBOLS.map((s) => {
      const x = summary.symbols[s];
      return `${s} ws${x.wsTicks}건 rest${x.restSnapshots}건 마지막(ws-rest)대금차=${x.lastWsVsRestAmt?.diff ?? '-'} 구간합=${x.windowWsSumVsRestDelta.wsSumAmt}/REST증가=${x.windowWsSumVsRestDelta.restDeltaAmt ?? '-'}`;
    }).join(' | ');
    const closeEvents = events.filter((e) => e.type !== 'open' && e.type !== 'control').length;
    await client.from('cron_run_logs').insert({
      cron: 'ws-program-test', user_agent: 'ws_program_trade_test', status: ticks.length > 0 ? 'ok' : 'empty',
      count: ticks.length, saved: true, error: `${brief} | 끊김/오류 이벤트 ${closeEvents}건 | 파일 ${outFile}`.slice(0, 1000),
      started_at: new Date(endAt - TEST_MINUTES * 60 * 1000).toISOString(), finished_at: new Date().toISOString(),
    });
  }
}

(async () => {
  try {
    const ymd = process.argv.includes('--now') ? kstNow().ymd : await waitForOpenDayStart();
    await runTest(ymd);
    log('시험 종료');
    process.exit(0);
  } catch (e) {
    log('[시험 실패]', e);
    process.exit(1);
  }
})();
