import { VwapReclaimSignal, PivotReclaimSignal } from './types';

// InvestorRankingTable.tsx(데스크톱)와 MobileRankingList.tsx(모바일)가 "VWAP 실시간 감시"/"피봇
// 재돌파 감시" 토글에서 동일하게 재사용하는 fetch 함수 - 중복 구현 금지(수칙 1-6).
//
// 🎯 [아키텍처 개선 - 사용자 질문: "다른 방법은 없어?"] 예전엔 vwap-watch/pivot-watch가 별도 API
// 라우트(별도 서버리스 함수)였는데, 두 감시를 동시에 켜면 같은 종목의 현재가를 KIS에 각자 중복으로
// 물어보는 문제가 있었다 - 서버리스 함수 간에는 캐시를 공유할 수 없어 dedupe 캐시로는 못 고쳤다.
// 하나의 라우트(reclaim-watch)로 합쳐서 근본 해결했다 - 이 클라이언트도 하나로 합친다.
export interface ReclaimWatchSignal {
  symbol: string;
  vwap: VwapReclaimSignal;
  pivot: PivotReclaimSignal;
}

export async function fetchReclaimWatchSignals(symbols: string[]): Promise<Map<string, ReclaimWatchSignal>> {
  const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));
  if (uniqueSymbols.length === 0) return new Map();

  const res = await fetch(`/api/stock/reclaim-watch?symbols=${uniqueSymbols.join(',')}`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || 'VWAP/피봇 재돌파 감시 중 오류가 발생했습니다.');
  }
  const data = await res.json();
  const map = new Map<string, ReclaimWatchSignal>();
  (data.results || []).forEach((r: ReclaimWatchSignal) => map.set(r.symbol, r));
  return map;
}

// 🎯 [기능 재설계 - 사용자 요청: "재돌파 임박 → 재돌파 확인(방금 발생) → 돌파 완료(유지 중) → 완료 후
// 5분 경과(오래된 이벤트) - 이런 신호의 신선도를 넣어"] kisApi.ts의 서버 상수(RECLAIM_CONFIRM_HOLD_MS,
// RECLAIM_STALE_MS)와 동일한 값을 클라이언트에도 둔다 - 데스크톱(InvestorRankingTable.tsx)과
// 모바일(MobileRankingList.tsx)이 배지 문구·정렬 우선순위를 각자 다시 구현하면 두 화면이 어긋날
// 위험이 있어(수칙 1-6) 하나의 함수로 합쳤다.
export const RECLAIM_CONFIRM_MS = 30_000;
export const RECLAIM_STALE_MS = 5 * 60_000;
export const FREQUENT_FLIP_CROSS_COUNT = 4; // 실측 90 백분위수=4(기존 값 그대로 유지)

export function formatReclaimElapsed(elapsedMs: number): string {
  if (elapsedMs < 60_000) return `${Math.max(0, Math.floor(elapsedMs / 1000))}초`;
  return `${Math.floor(elapsedMs / 60_000)}분`;
}

export type ReclaimFreshnessTier = 'justConfirmed' | 'holding' | 'established';

export interface ReclaimFreshnessInfo {
  tier: ReclaimFreshnessTier;
  isFrequentFlip: boolean;
  priority: number; // 정렬 우선순위 - 높을수록 화면 위쪽(더 신선하고 액션 가능한 신호)
  elapsedLabel: string;
}

// 🚨 [버그 수정 - 사용자 지적: "대우건설이 무슨 잦은등락이야, 지금 계속 고가 뚫고 가는구만"] crossCount는
// 장중 누적치라 아침에 잠깐 흔들렸던 종목이 그 뒤 몇 시간을 안정적으로 버텨도 예전엔 영원히 "잦은 등락"
// 으로 남았다 - elapsedMs가 RECLAIM_STALE_MS(5분) 이상이면(최근 행동이 안정적) 더 이상 노이즈로
// 취급하지 않는다.
export function computeReclaimFreshnessInfo(elapsedMs: number, crossCount: number): ReclaimFreshnessInfo {
  const isFrequentFlip = crossCount >= FREQUENT_FLIP_CROSS_COUNT && elapsedMs < RECLAIM_STALE_MS;
  const tier: ReclaimFreshnessTier = elapsedMs < RECLAIM_CONFIRM_MS ? 'justConfirmed' : elapsedMs < RECLAIM_STALE_MS ? 'holding' : 'established';
  const priority = isFrequentFlip ? 1.5 : tier === 'justConfirmed' ? 4 : tier === 'holding' ? 3 : 2;
  return { tier, isFrequentFlip, priority, elapsedLabel: formatReclaimElapsed(elapsedMs) };
}
