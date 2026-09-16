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
