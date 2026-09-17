/**
 * 🚨 [버그 수정] "종목 검색 옆 전 탭 뱃지 모음" 기능을 만들다가 실측으로 발견한 문제: 랭킹류 캐시가
 * 전부 평범한 모듈 스코프 `const cache = new Map()`였는데, Next.js가 route.ts 파일마다 별도 번들/모듈
 * 인스턴스를 만드는 경우(로컬 Turbopack HMR, Vercel 서버리스 함수 분리 등) 이 Map이 라우트마다 따로
 * 생성돼서 "A 탭에서 방금 계산해둔 캐시를 B 탭(다른 route.ts)에서는 전혀 못 본다"는 게 실측으로
 * 확인됐다(당일교집합 라우트에서 예열해도 직후 다른 라우트에서 조회하면 0건). KIS 토큰 캐시가 이미 이
 * 문제를 globalThis + Symbol.for로 풀어놨던 것과 동일한 패턴을 재사용해서, 진짜 프로세스 전역으로
 * 공유되는 Map을 만든다.
 *
 * kisApi.ts와 mockData.ts가 서로를 import하는 순환 참조 없이 양쪽 다 이 함수를 쓸 수 있도록 별도
 * 파일로 분리했다(수칙 1-6 - kisApi.ts 안에 있던 것을 그대로 이동, 재구현 아님).
 */
export function getGlobalMap<K, V>(name: string): Map<K, V> {
  const key = Symbol.for(`kos_for_global_cache_${name}`);
  const g = globalThis as any;
  if (!g[key]) g[key] = new Map<K, V>();
  return g[key] as Map<K, V>;
}
