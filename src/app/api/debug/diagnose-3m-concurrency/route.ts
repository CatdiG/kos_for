import { NextRequest, NextResponse } from 'next/server';
import { getKisAccessToken } from '@/lib/kisApi';

// 🚨 [임시 진단 전용 라우트] 로컬 샌드박스 → KIS 직접 호출 실측(동시성 2~14개 전부 문제없음, 레이트리밋도
// 즉시 거부일 뿐 hang 없음)과, 실제 프로덕션(Vercel 서버리스 → KIS)에서 겪은 30초~3분 hang이 서로 다른
// 결과를 보였다 - 네트워크 경로 자체가 다르므로(로컬 프로세스 vs Vercel 서버리스 함수), 진짜 원인이
// "동시 요청 개수"가 아니라 "Vercel 서버리스 환경 특유의 문제"(예: undici의 frozen/재사용 keep-alive
// 소켓이 죽어있는데 감지를 못 해 fetch가 영원히 안 끝나는 알려진 유형의 버그)일 가능성을 확인하기 위해
// 동일한 실험을 Vercel 함수 내부에서 직접 실행해 비교한다. 진단 완료 후 이 라우트는 제거한다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const ALL_SLOTS = ['090000', '093000', '100000', '103000', '110000', '113000', '120000', '123000', '130000', '133000', '140000', '143000', '150000', '153000'];

async function fetchOneSlot(token: string, appKey: string, appSecret: string, baseUrl: string, symbol: string, slotHour: string) {
  const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${symbol}&FID_INPUT_HOUR_1=${slotHour}&FID_PW_DATA_INCU_YN=Y&FID_ETC_CLS_CODE=`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHKST03010200',
        custtype: 'P',
      },
      signal: AbortSignal.timeout(10000),
    });
    const elapsed = Date.now() - t0;
    const json = await res.json().catch(() => null);
    const isRateLimit = !!json && (json.msg_cd === 'EGW00201' || json.msg_cd === 'EGW00202' || json.msg_cd === 'EGW00133' || (json.msg1 && (json.msg1.includes('초당') || json.msg1.includes('초과'))));
    const ok = res.ok && json && json.rt_cd === '0' && !isRateLimit;
    return { symbol, slotHour, elapsed, ok, isRateLimit, msg: json ? (json.msg1 || json.msg_cd || '') : '(파싱실패)' };
  } catch (e: any) {
    return { symbol, slotHour, elapsed: Date.now() - t0, ok: false, isRateLimit: false, msg: `EXCEPTION: ${e?.message || e}` };
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const secretParam = url.searchParams.get('secret');
  if (!cronSecret || secretParam !== cronSecret.trim()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const isVirtual = process.env.KIS_VIRTUAL === 'true';
  const baseUrl = isVirtual ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443';

  const token = await getKisAccessToken();
  if (!token) {
    return NextResponse.json({ error: '토큰 발급 실패' }, { status: 500 });
  }

  // 실험 A: 종목 1개(005930) 14개 슬롯 완전 동시 병렬 - Vercel 함수 내부에서 직접 실행
  const tA0 = Date.now();
  const resultsA = await Promise.all(ALL_SLOTS.map((slot) => fetchOneSlot(token, appKey, appSecret, baseUrl, '005930', slot)));
  const elapsedA = Date.now() - tA0;

  await new Promise((r) => setTimeout(r, 3000));

  // 실험 B: 5개 종목 × 14슬롯 = 70개 요청, 종목마다 300ms 텀만 두고 발사
  const stressSymbols = ['005930', '000660', '035720', '373220', '068270'];
  const tB0 = Date.now();
  const allTasksB = stressSymbols.map((sym, i) =>
    (async () => {
      await new Promise((r) => setTimeout(r, i * 300));
      return Promise.all(ALL_SLOTS.map((slot) => fetchOneSlot(token, appKey, appSecret, baseUrl, sym, slot)));
    })()
  );
  const resultsB = (await Promise.all(allTasksB)).flat();
  const elapsedB = Date.now() - tB0;

  const summarize = (arr: any[]) => ({
    total: arr.length,
    success: arr.filter((r) => r.ok).length,
    rateLimit: arr.filter((r) => r.isRateLimit).length,
    otherFail: arr.filter((r) => !r.ok && !r.isRateLimit).length,
    maxLatencyMs: Math.max(...arr.map((r) => r.elapsed)),
    avgLatencyMs: Math.round(arr.reduce((s, r) => s + r.elapsed, 0) / arr.length),
    failDetail: arr.filter((r) => !r.ok).map((r) => ({ symbol: r.symbol, slotHour: r.slotHour, elapsed: r.elapsed, msg: r.msg })),
  });

  return NextResponse.json({
    region: process.env.VERCEL_REGION || 'unknown',
    experimentA_14parallel_1symbol: { elapsedMs: elapsedA, ...summarize(resultsA) },
    experimentB_70req_5symbols_staggered: { elapsedMs: elapsedB, ...summarize(resultsB) },
  });
}
