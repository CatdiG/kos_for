// 🚨 [버그 수정 - 사용자 지적: "위에이씨는 코스피와 차트에 있는 코스피의 숫자가 달라"] 코스피/코스닥
// 상단 카드(IndexCards.tsx/MobileIndexCards.tsx)와 지수 상세 패널(IndexDetailChart.tsx/
// MobileIndexDetailChart.tsx)이 각자 자기만의 fetch 함수·쿼리키로 따로 요청을 쏘고 있었다:
//   - 카드: fetchIndexSummary, queryKey ['indexSummary', market], summaryOnly=1(현재가만, 가벼움)
//   - 상세 패널: fetchIndexTrend, queryKey ['indexTrend', market, period], 전체 일봉까지 포함
// 게다가 카드는 refetchInterval:30초로 계속 최신화되는데, 상세 패널 쪽엔 그 설정 자체가 없어서
// 패널을 연 시점에 딱 한 번만 조회되고 그 뒤로 전혀 갱신되지 않았다 - 그래서 카드(최신)와 열려있던
// 패널(연 시점에 멈춘 스냅샷)이 서로 다른 숫자를 보여주는 게 실측으로 확인됐다(예: 카드 6,665.89
// vs 패널 6,662.72, 패널의 "오늘" 캔들이 그 시점 기준 양봉으로 굳어있던 것도 같은 원인).
// 4곳 전부 이 파일 하나의 fetch 함수·쿼리키·재조회 주기를 공유하게 통합한다(수칙 1-6) - 카드의
// 기본 기간(5일)과 상세 패널의 기본 기간이 겹칠 때는 React Query가 완전히 동일한 쿼리키를 인식해
// 캐시 엔트리 자체를 공유하므로(중복 네트워크 요청 없이 하나의 값을 같이 봄), 기간을 20일/60일로
// 바꿔도 동일한 30초 주기로 계속 최신 상태를 유지한다.
import { IndexTrendResponse, TrendPeriod } from './types';

export const INDEX_REFETCH_INTERVAL_MS = 30 * 1000;

export function indexTrendQueryKey(market: 'KOSPI' | 'KOSDAQ', period: TrendPeriod) {
  return ['indexTrend', market, period] as const;
}

export async function fetchIndexTrend(market: 'KOSPI' | 'KOSDAQ', period: TrendPeriod): Promise<IndexTrendResponse> {
  const res = await fetch(`/api/stock/index-trend?market=${market}&period=${period}`);
  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    throw new Error(errJson?.error || '지수 데이터를 불러오는데 실패했습니다.');
  }
  return res.json();
}
