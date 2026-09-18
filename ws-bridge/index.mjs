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

// ── Supabase REST 업서트: 관심종목 실시간 현재가 (SDK 없이 PostgREST 직접 호출) ──────────────
// 🎯 [기능 추가 - 사용자 요청: "관심종목 웹소캣으로 실시간 된다는거 아니였어? 안되는데" - "진짜 push로
// 바꾸자"] 지금까지 이 프로세스는 KIS 체결 틱을 받아서 3분봉(intraday_3m_candles)에만 저장했다 - 화면의
// 관심종목 현재가는 30초 REST 폴링으로 따로 조회했다. 이미 받고 있는 틱에서 전일대비/전일대비율/누적
// 거래량 필드 3개를 추가로 읽어서 이 표에 upsert하면, 브라우저가 Supabase Realtime(Postgres 변경
// 스트림)을 구독하는 것만으로 새 웹소켓 서버 없이 진짜 push가 된다.
async function upsertQuotesToSupabase(rows) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/realtime_quotes?on_conflict=symbol`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const text = await res.text();
      log(`[Supabase realtime_quotes 저장 실패] HTTP ${res.status} ${text}`);
    }
  } catch (e) {
    log('[Supabase realtime_quotes 저장 예외]', e.message);
  }
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

// 🎯 [기능 추가 - 관심종목 실시간 현재가] symbol -> 최신 시세(가격/전일대비/등락율/누적거래량).
// 3분봉과 별개로 "지금 이 순간 값"만 들고 있다가 짧은 주기로 realtime_quotes에 흘려보낸다.
const latestQuotes = new Map();
const dirtyQuoteSymbols = new Set();

function ingestQuote(symbol, price, change, changeRate, cumVol) {
  if (!Number.isFinite(price) || price <= 0) return;
  latestQuotes.set(symbol, { price, change, changeRate, volume: cumVol });
  dirtyQuoteSymbols.add(symbol);
}

async function flushDirtyQuotes() {
  if (dirtyQuoteSymbols.size === 0) return;
  const toFlush = [...dirtyQuoteSymbols];
  dirtyQuoteSymbols.clear();

  const rows = toFlush
    .map((symbol) => {
      const q = latestQuotes.get(symbol);
      if (!q) return null;
      return { symbol, price: q.price, change: q.change, change_rate: q.changeRate, volume: q.volume, updated_at: new Date().toISOString() };
    })
    .filter(Boolean);
  if (rows.length === 0) return;
  await upsertQuotesToSupabase(rows);
}

// 관심종목 현재가는 화면 체감 속도가 핵심이라 3분봉(15초)보다 훨씬 짧은 주기로 흘려보낸다 - 매 틱마다
// 바로 쏘면 고빈도 종목에서 Supabase 쓰기 폭주가 나므로, 그 사이 값은 latestQuotes에서 계속 덮어쓰고
// 이 주기에만 "그 순간의 최신값"을 내보낸다(3분봉 flushDirtySymbols와 동일한 dirty-set 패턴, 수칙 1-6).
setInterval(() => {
  flushDirtyQuotes().catch((e) => log('[관심종목 시세 플러시 에러]', e.message));
}, 2000);

function getKstDateStr() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// 🚨 [버그 수정 - 사용자 지적: "성호전자는 3분봉 안움직이는데?"] candleState가 순수 인메모리라, 이
// 프로세스가 재시작되면(오늘처럼 배포 재기동, 혹은 서버 재부팅) 그날 이미 쌓인 봉을 전부 잊어버리고
// 처음부터 다시 쌓기 시작했다 - 그런데 upsertCandlesToSupabase가 "새로 쌓은 것만"을 그 날짜 행에
// 통째로 덮어써서, 재시작 이후에도 계속 체결이 들어온 종목(예: SK하이닉스)은 09:00~재시작 전 구간의
// 정규장 캔들이 통째로 사라졌다(실측: 재시작 후 57개만 남고 09:00~14:39 구간 소실). 재시작 직후
// Supabase에 이미 저장된 오늘자 캔들을 먼저 읽어와 candleState를 복원한 뒤 틱 처리를 시작하면, 새
// 틱은 기존 봉 위에 "이어 쌓이기"만 하고 과거 봉은 그대로 보존된다.
async function hydrateCandleStateFromSupabase(symbols) {
  if (!symbols || symbols.length === 0) return;
  const todayStr = getKstDateStr();
  try {
    const symbolFilter = symbols.map((s) => `"${s}"`).join(',');
    const res = await fetch(`${SUPABASE_URL}/rest/v1/intraday_3m_candles?date=eq.${todayStr}&symbol=in.(${symbolFilter})&select=symbol,candles`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) {
      log('[캔들 복원 실패] HTTP', res.status);
      return;
    }
    const rows = await res.json();
    let restoredSymbols = 0;
    let restoredBuckets = 0;
    for (const row of rows) {
      if (!Array.isArray(row.candles) || row.candles.length === 0) continue;
      const bucketMap = new Map();
      for (const c of row.candles) {
        if (!c.time) continue;
        bucketMap.set(c.time, c);
      }
      if (bucketMap.size === 0) continue;
      candleState.set(row.symbol, bucketMap);
      restoredSymbols++;
      restoredBuckets += bucketMap.size;
    }
    if (restoredSymbols > 0) {
      log(`[캔들 복원 완료] ${restoredSymbols}종목, 총 ${restoredBuckets}개 봉 - 재시작으로 오늘자 캔들이 끊기지 않도록 이어받음`);
    }
  } catch (e) {
    log('[캔들 복원 예외]', e.message);
  }
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
    if (block.length < 14) continue;
    const symbol = block[0];
    const time = block[1];
    const price = parseInt(block[2], 10);
    const tickVol = parseInt(block[12], 10);
    ingestTick(symbol, time, price, tickVol);

    // 🎯 [기능 추가 - 관심종목 실시간 현재가, 실측 확정(scratch/verify_ws_field_layout.mjs, SK하이닉스
    // 기준 REST prdy_vrss_sign/prdy_vrss/prdy_ctrt와 필드 [3][4][5]가 정확히 일치함을 대조 확인)]
    // [3]=전일대비부호(1/2=상승,3=보합,4/5=하락), [4]=전일대비, [5]=전일대비율, [13]=누적거래량.
    // 부호 규칙은 fetchKisWatchlistQuotes(kisApi.ts)의 REST 응답 처리와 완전히 동일하게 맞춘다(수칙 1-6).
    const sign = block[3];
    const changeAbs = parseInt(block[4], 10);
    const changeRate = parseFloat(block[5]);
    const cumVol = parseInt(block[13], 10);
    if (Number.isFinite(changeAbs) && Number.isFinite(changeRate) && Number.isFinite(cumVol)) {
      const change = (sign === '4' || sign === '5') ? -Math.abs(changeAbs) : Math.abs(changeAbs);
      ingestQuote(symbol, price, change, changeRate, cumVol);
    }
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
  await hydrateCandleStateFromSupabase(initialSymbols);

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

  if (toAdd.length > 0) await hydrateCandleStateFromSupabase(toAdd); // 새로 추가된 종목도 오늘자 기존 캔들이 있으면 이어받기
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
