// 🎯 [KIS 실시간 웹소켓 브릿지] H0UNCNT0(국내주식 실시간체결가 통합)를 상시 구독해서
// KRX+NXT가 합쳐진 진짜 통합 틱을 받아 3분봉으로 집계하고 Supabase(intraday_3m_candles)에 저장한다.
//
// 실측으로 확정된 사실(scratch/test_kis_websocket*.mjs에서 검증):
// - approval_key: POST https://openapi.koreainvestment.com:9443/oauth2/Approval (body key는 "secretkey")
// - 접속 URL: ws://ops.koreainvestment.com:21000 (실전)
// - 구독 성공 시 시세 데이터는 암호화 안 됨(encrypt:"N") - AES 복호화 불필요
// - 응답은 "0|H0UNCNT0|건수|필드1^필드2^...^필드47(건수만큼 반복)" 형식
// - 필드 개수는 47개다(H0STCNT0 구버전 46개 문서를 그대로 썼다가 다중 블록 메시지에서 필드가
//   밀리는 실측 버그를 겪은 뒤 직접 raw 메시지를 세어서 확정함) - 절대 46으로 되돌리지 말 것.
// - 계정(세션)당 동시 구독 가능 종목 수는 41개로 알려져 있음.
//
// 의존성 없음(순수 Node.js 22+ 내장 fetch/WebSocket만 사용) - 서버에 npm install 없이 이 파일
// 하나와 .env만 올리면 바로 동작한다.
//
// 🎯 [관심종목이 자주 바뀌는 문제 해결] 감시 종목을 로컬 config/symbols.json 같은 정적 파일이 아니라
// Supabase(ws_watchlist) 테이블로 관리한다 - 앱 화면에서 종목을 추가/삭제하면 이 프로세스가 30초마다
// 폴링해서 자동으로 KIS 웹소켓 구독을 갱신한다(SSH로 서버 파일 고치고 재시작할 필요 없음).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 환경변수 로드 (.env, dotenv 의존성 없이 직접 파싱) ──────────────────────
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    env[key] = value;
  }
  return env;
}

const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };

const KIS_APPKEY = env.KIS_APPKEY;
const KIS_APPSECRET = env.KIS_APPSECRET;
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!KIS_APPKEY || !KIS_APPSECRET) {
  console.error('[설정 오류] KIS_APPKEY / KIS_APPSECRET이 .env에 없습니다.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[설정 오류] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 .env에 없습니다.');
  process.exit(1);
}

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ── 감시 종목 목록 조회 (Supabase ws_watchlist 테이블, 최대 41개) ────────────
async function fetchWatchlistFromSupabase() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ws_watchlist?select=symbol&order=added_at.asc`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) {
      log('[관심종목 조회 실패] HTTP', res.status);
      return null;
    }
    const rows = await res.json();
    let symbols = rows.map((r) => r.symbol);
    if (symbols.length > 41) {
      log(`[경고] 관심종목이 41개를 초과함(${symbols.length}개) - 먼저 추가한 41개만 구독합니다.`);
      symbols = symbols.slice(0, 41);
    }
    return symbols;
  } catch (e) {
    log('[관심종목 조회 예외]', e.message);
    return null;
  }
}

// ── approval_key 발급 (24시간 정도 유효한 것으로 알려져 있어 12시간마다 선제 갱신) ──
let approvalKey = null;

async function fetchApprovalKey() {
  const res = await fetch('https://openapi.koreainvestment.com:9443/oauth2/Approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APPKEY, secretkey: KIS_APPSECRET }),
  });
  const body = await res.json();
  if (!body.approval_key) {
    throw new Error(`approval_key 발급 실패: ${JSON.stringify(body)}`);
  }
  return body.approval_key;
}

// ── Supabase REST 업서트 (SDK 없이 PostgREST 직접 호출) ─────────────────────
async function upsertCandlesToSupabase(dateStr, symbol, candles) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/intraday_3m_candles?on_conflict=date,symbol`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ date: dateStr, symbol, candles, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const text = await res.text();
      log(`[Supabase 저장 실패] ${symbol}: HTTP ${res.status} ${text}`);
    }
  } catch (e) {
    log(`[Supabase 저장 예외] ${symbol}:`, e.message);
  }
}

// ── 3분봉 상태 관리 (종목별로 오늘 하루치 캔들을 시간 버킷 Map으로 유지) ────────
const FIELD_COUNT = 47; // 실측 확정값 - 절대 46으로 되돌리지 말 것 (위 상단 주석 참고)

const candleState = new Map(); // symbol -> Map<bucketKey(HH:MM), candle>
const dirtySymbols = new Set(); // 마지막 플러시 이후 갱신된 종목

function getKstDateStr() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
}

function bucketKeyOf(hhmmss) {
  const h = hhmmss.slice(0, 2);
  const m = parseInt(hhmmss.slice(2, 4), 10);
  const bm = Math.floor(m / 3) * 3;
  return `${h}:${String(bm).padStart(2, '0')}`;
}

function ingestTick(symbol, hhmmss, price, tickVol) {
  if (!Number.isFinite(price) || price <= 0) return;
  const todayStr = getKstDateStr();
  const key = bucketKeyOf(hhmmss);

  if (!candleState.has(symbol)) candleState.set(symbol, new Map());
  const symbolBuckets = candleState.get(symbol);

  if (!symbolBuckets.has(key)) {
    symbolBuckets.set(key, {
      date: todayStr,
      time: key,
      rawTime: hhmmss,
      openPrice: price,
      highPrice: price,
      lowPrice: price,
      closePrice: price,
      volume: 0,
    });
  }
  const c = symbolBuckets.get(key);
  if (hhmmss >= c.rawTime) {
    c.closePrice = price;
    c.rawTime = hhmmss;
  }
  c.highPrice = Math.max(c.highPrice, price);
  c.lowPrice = Math.min(c.lowPrice, price);
  c.volume += Number.isFinite(tickVol) ? tickVol : 0;

  dirtySymbols.add(symbol);
}

async function flushDirtySymbols() {
  if (dirtySymbols.size === 0) return;
  const todayStr = getKstDateStr();
  const toFlush = [...dirtySymbols];
  dirtySymbols.clear();

  for (const symbol of toFlush) {
    const symbolBuckets = candleState.get(symbol);
    if (!symbolBuckets) continue;
    const candles = [...symbolBuckets.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
    await upsertCandlesToSupabase(todayStr, symbol, candles);
  }
  log(`[플러시 완료] ${toFlush.length}종목 Supabase 저장`);
}

setInterval(() => {
  flushDirtySymbols().catch((e) => log('[플러시 에러]', e.message));
}, 15000); // 15초마다 변경된 종목만 저장

// ── 메시지 파싱 ──────────────────────────────────────────────────────────
// 🚨 [버그 수정 - 사용자 지적: "왜 자꾸 100초마다 끊기지?"] 실측(journalctl 로그)으로 웹소켓이
// 정확히 ~101초 간격으로 계속 재연결되는 걸 확인했다 - KIS가 주기적으로 보내는 PINGPONG 제어
// 메시지를 그대로 echo(그대로 재전송)해줘야 하트비트가 유지되는데, 이 처리가 빠져 있어서 KIS가
// 응답 없는 연결로 판단해 계속 끊었던 것이었다(수칙 1-2, 제 실수 인정). tr_id가 "PINGPONG"이면
// 받은 그대로 되돌려 보낸다.
function handleMessage(raw, ws) {
  if (!raw.startsWith('0|H0UNCNT0')) {
    // 구독 성공/실패 등 제어 메시지 (JSON)
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.header?.tr_id === 'PINGPONG') {
          ws.send(raw); // 받은 그대로 echo - 하트비트 응답
          return;
        }
        if (parsed?.body?.msg1) log('[제어 메시지]', parsed.body.msg1, parsed?.header?.tr_key || '');
      } catch {
        // 무시 - 파싱 실패한 제어 메시지는 무해하므로 조용히 스킵
      }
    }
    return;
  }
  const parts = raw.split('|');
  const count = parseInt(parts[2], 10);
  const fields = parts[3].split('^');
  for (let i = 0; i < count; i++) {
    const block = fields.slice(i * FIELD_COUNT, (i + 1) * FIELD_COUNT);
    if (block.length < 13) continue;
    const symbol = block[0];
    const time = block[1];
    const price = parseInt(block[2], 10);
    const tickVol = parseInt(block[12], 10);
    ingestTick(symbol, time, price, tickVol);
  }
}

// ── 웹소켓 연결 + 재연결 로직 ─────────────────────────────────────────────
let reconnectDelayMs = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;

let liveWs = null; // 현재 열려있는 연결 (동적 구독/해제 메시지 전송용)
let subscribedSymbols = new Set(); // 이 연결에서 실제로 구독 중인 종목

function sendSubscribe(ws, symbol, trType) {
  ws.send(JSON.stringify({
    header: { approval_key: approvalKey, custtype: 'P', tr_type: trType, 'content-type': 'utf-8' },
    body: { input: { tr_id: 'H0UNCNT0', tr_key: symbol } },
  }));
}

async function connect() {
  try {
    approvalKey = await fetchApprovalKey();
    log('approval_key 발급 완료');
  } catch (e) {
    log('[approval_key 발급 실패]', e.message, `- ${reconnectDelayMs / 1000}초 후 재시도`);
    scheduleReconnect();
    return;
  }

  const initialSymbols = (await fetchWatchlistFromSupabase()) || [];
  if (initialSymbols.length === 0) {
    log('[관심종목 없음] ws_watchlist가 비어있거나 조회 실패 - 30초 후 다시 확인');
    setTimeout(() => connect().catch((e) => log('[재연결 실패]', e.message)), 30000);
    return;
  }
  log(`[초기화] 감시 종목 ${initialSymbols.length}개:`, initialSymbols.join(', '));

  const ws = new WebSocket('ws://ops.koreainvestment.com:21000');
  liveWs = ws;

  ws.addEventListener('open', () => {
    log('웹소켓 연결 성공, 종목 구독 시작...');
    reconnectDelayMs = 2000; // 연결 성공하면 백오프 초기화
    subscribedSymbols = new Set(initialSymbols);
    for (const symbol of initialSymbols) {
      sendSubscribe(ws, symbol, '1');
    }
  });

  ws.addEventListener('message', (event) => {
    try {
      handleMessage(event.data.toString(), ws);
    } catch (e) {
      log('[메시지 처리 에러]', e.message);
    }
  });

  ws.addEventListener('error', (event) => {
    log('[웹소켓 에러]', event.message || event);
  });

  ws.addEventListener('close', (event) => {
    if (liveWs === ws) liveWs = null;
    log(`웹소켓 연결 종료 (code=${event.code}) - ${reconnectDelayMs / 1000}초 후 재연결`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  setTimeout(() => {
    connect().catch((e) => log('[재연결 실패]', e.message));
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

// 관심종목 목록을 30초마다 폴링해서 추가/삭제된 종목만 구독/해제한다(연결 재시작 없이 즉시 반영).
setInterval(async () => {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return; // 재연결 중이면 다음 연결 시 initialSymbols로 처리됨
  const desired = await fetchWatchlistFromSupabase();
  if (!desired) return; // 조회 실패 시 이번 주기는 조용히 건너뜀 (기존 구독 유지)

  const desiredSet = new Set(desired);
  const toAdd = desired.filter((s) => !subscribedSymbols.has(s));
  const toRemove = [...subscribedSymbols].filter((s) => !desiredSet.has(s));

  for (const symbol of toAdd) {
    sendSubscribe(liveWs, symbol, '1');
    subscribedSymbols.add(symbol);
  }
  for (const symbol of toRemove) {
    sendSubscribe(liveWs, symbol, '2');
    subscribedSymbols.delete(symbol);
  }
  if (toAdd.length > 0 || toRemove.length > 0) {
    log(`[관심종목 갱신] 추가: ${toAdd.join(', ') || '없음'} / 제거: ${toRemove.join(', ') || '없음'}`);
  }
}, 30000);

// approval_key는 넉넉하게 6시간마다 선제 재발급 (정확한 만료시간 미확인 - 안전하게 자주 갱신)
setInterval(async () => {
  try {
    approvalKey = await fetchApprovalKey();
    log('[approval_key 정기 갱신 완료]');
  } catch (e) {
    log('[approval_key 정기 갱신 실패]', e.message);
  }
}, 6 * 60 * 60 * 1000);

process.on('SIGTERM', async () => {
  log('종료 신호 수신, 마지막 데이터 저장 중...');
  await flushDirtySymbols();
  process.exit(0);
});

connect();
