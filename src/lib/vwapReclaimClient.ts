import { VwapReclaimSignal, PivotReclaimSignal } from './types';

// InvestorRankingTable.tsx(데스크톱)와 MobileRankingList.tsx(모바일)가 "VWAP 실시간 감시" 토글에서
// 동일하게 재사용하는 fetch 함수 - 중복 구현 금지(수칙 1-6), src/lib/indexClient.ts와 동일한 패턴.
// 🚨 [재설계 - 사용자 요청: "더 빠르게, 5개로 안 좁혀도 되게"] 예전엔 종목당 3분봉 14콜짜리 온디맨드
// 1회성 체크였는데, 이제 종목당 1콜(당일 현재가의 누적거래량/누적거래대금으로 VWAP 즉시 계산)짜리
// 실시간 감시 방식으로 바뀌어서, 호출하는 쪽(컴포넌트)이 짧은 주기로 반복 호출해도 부담이 적다.
export async function fetchVwapWatchSignals(symbols: string[]): Promise<Map<string, VwapReclaimSignal>> {
  const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));
  if (uniqueSymbols.length === 0) return new Map();

  const res = await fetch(`/api/stock/vwap-watch?symbols=${uniqueSymbols.join(',')}`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || 'VWAP 실시간 감시 중 오류가 발생했습니다.');
  }
  const data = await res.json();
  const map = new Map<string, VwapReclaimSignal>();
  (data.results || []).forEach((r: VwapReclaimSignal) => map.set(r.symbol, r));
  return map;
}

// 🎯 [기능 추가 - 사용자 요청: "R1/R2 재돌파도 보고싶어"] VWAP와 별개의 감시 토글에서 쓰는 fetch 함수 -
// 동일한 파일에 묶어둔 이유는 두 함수 다 "InvestorRankingTable.tsx/MobileRankingList.tsx 공용 감시
// 클라이언트"라는 같은 역할이기 때문(수칙 1-6, 파일을 새로 쪼개지 않음).
export async function fetchPivotWatchSignals(symbols: string[]): Promise<Map<string, PivotReclaimSignal>> {
  const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));
  if (uniqueSymbols.length === 0) return new Map();

  const res = await fetch(`/api/stock/pivot-watch?symbols=${uniqueSymbols.join(',')}`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '피봇 재돌파 감시 중 오류가 발생했습니다.');
  }
  const data = await res.json();
  const map = new Map<string, PivotReclaimSignal>();
  (data.results || []).forEach((r: PivotReclaimSignal) => map.set(r.symbol, r));
  return map;
}
