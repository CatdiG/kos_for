/**
 * KRX 가격대별 호가단위(aspr_unit) 판별 - 데스크톱(RankingStockDetailChart.tsx)과 모바일 3분봉
 * (MobileIntraday3mChart.tsx) 차트가 같이 쓰는 공통 함수(수칙 1-6: 각자 복사해 두지 않는다).
 */
export function getKrxTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}
