// KIS 국내휴장일조회(CTCA0903R)로 "오늘 장이 열리는 날인지" 판별 - scripts/* 공용(수칙 1-6).
// 2026-09-23 실측: 응답의 opnd_yn(개장일 여부)이 정확하다(9/24~9/27 추석 연휴·주말 N, 9/28 Y).
// tr_day_yn(거래일 여부)은 휴일에도 Y로 나와서 판단 기준으로 쓰지 않는다.
// KIS가 이 TR을 하루 1회 정도로 쓰도록 안내하므로 날짜별로 결과를 캐시한다.
const cache = new Map(); // ymd -> boolean

async function isKrxOpenDay(ymd, { token, appKey, appSecret, baseUrl = 'https://openapi.koreainvestment.com:9443' }) {
  if (cache.has(ymd)) return cache.get(ymd);
  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/chk-holiday?BASS_DT=${ymd}&CTX_AREA_NK=&CTX_AREA_FK=`;
  const res = await fetch(url, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: 'CTCA0903R',
      custtype: 'P',
    },
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (json.rt_cd !== '0' || !Array.isArray(json.output)) {
    throw new Error(`휴장일 조회 실패: rt_cd=${json.rt_cd} ${json.msg1 || ''}`);
  }
  // 응답은 기준일부터 여러 날짜가 오므로 받은 날짜 전부 캐시해 둔다
  json.output.forEach((o) => cache.set(o.bass_dt, o.opnd_yn === 'Y'));
  if (!cache.has(ymd)) throw new Error(`휴장일 조회 응답에 ${ymd}가 없음`);
  return cache.get(ymd);
}

/** 지금 시각의 KST 구성요소 */
function kstNow(ms = Date.now()) {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // UTC 필드로 KST 값을 읽기 위한 이동
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();
  return { ymd, hhmm, dow: d.getUTCDay(), text: `${ymd} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}` };
}

module.exports = { isKrxOpenDay, kstNow };
