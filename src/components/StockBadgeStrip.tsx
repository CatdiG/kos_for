'use client';

// 종목 검색창과 종목명/가격 표시 사이의 빈 공간에, 지금 이 종목이 현재 존재하는 모든 랭킹 탭(급등주/
// 단타종합랭킹/외국인/기관/프로그램/수급교집합 당일·2일연속·3일연속)의 어디에 떠 있는지 한 줄로 모아
// 보여준다. 뱃지 문구/스타일은 각 탭에서 이미 쓰던 것을 그대로 재사용한다(새로 디자인하지 않음).

import { useQuery } from '@tanstack/react-query';
import { StockBadgeSummaryResponse } from '@/lib/types';

interface StockBadgeStripProps {
  symbol: string;
}

// 🚨 [기능 추가 - 사용자 요청] 종목상세 차트(MobileStockDetailChart.tsx)가 "기준(랭킹 캐시) vs
// 최신(방금 계산) 배지 비교"에 이 조회 결과를 그대로 재사용할 수 있도록 export한다(수칙 1-6 - 새
// fetch 함수를 또 만들지 않음). 같은 queryKey(['stockBadges', symbol])를 쓰면 React Query가 이미
// 이 컴포넌트가 받아온 캐시를 공유해 중복 네트워크 요청도 없다.
export async function fetchStockBadges(symbol: string): Promise<StockBadgeSummaryResponse> {
  const res = await fetch(`/api/stock/badges?symbol=${symbol}&market=ALL`);
  if (!res.ok) throw new Error('뱃지 조회 실패');
  return res.json();
}

const DEFAULT_BADGE_STYLE = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700';

// 수급교집합 탭의 주체별 연속매매 뱃지 - HistoryRankingTable/InvestorRankingTable과 동일한 매수/매도 배색
function entityBadgeColor(netBuyAmt: number) {
  return netBuyAmt >= 0
    ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/50'
    : 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-900/50';
}

// 🚨 [기능 추가 - 사용자 요청: "(3일연속기준)처럼 짧게 표시"] tabId 접두사로 짧은 주체명을 뽑는다 -
// kisApi.ts getStockBadgeSummary가 쓰는 tabId 명명 규칙과 1:1 대응(수칙 1-6, 새 매핑 하드코딩 대신
// 이미 존재하는 tabId 문자열 그대로 파생). 종목상세 차트(MobileStockDetailChart.tsx)가 기준/최신
// 배지 비교에 재사용한다(사용자 지시로 이 기능은 뱃지모음이 아니라 차트에만 둠).
export function shortSourceLabel(tabId: string): string {
  if (tabId.startsWith('foreign')) return '외국인';
  if (tabId.startsWith('organ')) return '기관';
  if (tabId.startsWith('program')) return '프로그램';
  if (tabId.startsWith('overlap-3d')) return '3일연속';
  if (tabId.startsWith('overlap-2d')) return '2일연속';
  if (tabId.startsWith('overlap-daily') || tabId.startsWith('overlap')) return '수급교집합';
  if (tabId.startsWith('surging')) return '급등주';
  if (tabId === 'comprehensive') return '단타종합';
  return tabId;
}

// 🚨 [버그 수정 - 사용자 지적: "뱃지모음엔 가장 최신거만 넣어"] 기준/최신 비교와 "(주체기준)" 태그는
// 종목상세 차트에만 두기로 하고(사용자 지시), 뱃지모음에서는 여러 탭에 같은 문구를 중복 노출하는 대신
// 실제로 가장 최신 데이터를 갖고 있을 탭 하나만 골라 그 문구만 보여준다. 정확한 시각 문자열 비교는
// 탭마다 포맷이 달라(예: "당일 가집계 (12:25 기준)" vs "(9/10 기준)") 신뢰할 수 없으므로(수칙 1-3 -
// 임시 파싱 숏컷 금지), 대신 이 코드베이스가 실제로 채택한 캐시 갱신 주기(kisApi.ts: 외국인/기관/
// 당일교집합/프로그램=장중 60초, 2·3일연속=그보다 훨씬 느린 재계산 주기)를 그대로 우선순위로 삼는다 -
// 갱신이 잦은 탭일수록 "지금"에 더 가깝다.
const FRESHNESS_PRIORITY = ['foreign', 'organ', 'program', 'overlap-daily', 'overlap-2d', 'overlap-3d'];
function freshnessRank(tabId: string): number {
  const idx = FRESHNESS_PRIORITY.findIndex((p) => tabId.startsWith(p));
  return idx === -1 ? FRESHNESS_PRIORITY.length : idx;
}

export default function StockBadgeStrip({ symbol }: StockBadgeStripProps) {
  const { data } = useQuery<StockBadgeSummaryResponse>({
    queryKey: ['stockBadges', symbol],
    queryFn: () => fetchStockBadges(symbol),
    enabled: Boolean(symbol),
    staleTime: 20 * 1000,
    refetchInterval: 30 * 1000,
  });

  const badges = data?.badges || [];
  if (badges.length === 0) return null;

  // 🚨 [버그 수정 - 사용자 지적: "뱃지모음엔 가장 최신거만 넣어"] 탭마다 statusBadge 문구가 다를 수
  // 있는데(수칙 1-5와 동일 취지 - 탭마다 캐시 시점이 다름), 여기서는 그 차이를 전부 나열하지 않고
  // FRESHNESS_PRIORITY 기준 가장 최신일 가능성이 높은 탭 하나의 값만 채택해 모든 탭 칩에 동일하게
  // 보여준다. 탭 간 불일치를 실제로 비교/표시하는 건 종목상세 차트(MobileStockDetailChart.tsx)의
  // 기준/최신 배지 몫으로 넘긴다(사용자 지시 - "그리고 차트에다가만 해").
  const freshestBadge = [...badges]
    .filter((b) => b.statusBadge)
    .sort((a, b) => freshnessRank(a.tabId) - freshnessRank(b.tabId))[0];

  return (
    // 🚨 [UI 수정] flex-1 하나로 옆 종목명 블록(shrink-0 없음)까지 밀어붙이던 걸,
    // 오른쪽에 명시적 여백(mr-3)을 둬서 뱃지가 아무리 여러 줄로 늘어나도 종목명 영역을 침범하지 않게 한다.
    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 px-1 lg:px-3 mr-3 lg:mr-4">
      {badges.map((b) => (
        <span
          key={b.tabId}
          title={`${b.tabLabel} ${b.rank}위${b.investorBadge ? ` · ${b.investorBadge}` : ''}`}
          // 🚨 [버그 수정] 배경색은 각 칩 자기 자신의 statusBadgeStyle을 쓰면서 문구만 freshestBadge
          // 것으로 바꾸면, 칩마다 색은 다른데 글자는 똑같은 모순된 모습이 된다 - 배경색도 freshestBadge
          // 것으로 통일해 색과 문구가 항상 같은 값을 가리키게 한다.
          className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap ${
            freshestBadge?.statusBadgeStyle || DEFAULT_BADGE_STYLE
          }`}
        >
          <span className="opacity-70 font-medium">{b.tabLabel}</span>
          <span>{b.rank}위</span>
          {/* 🚨 [기능 추가 - 사용자 요청: "뱃지모음에 이격도 뱃지도 넣어줘, 가장 최신거만"] 탭마다 각자의
              statusBadge를 반복 노출하지 않고, 전체 탭 중 가장 최신일 탭(freshestBadge) 하나의 문구만
              모든 칩에 동일하게 보여준다 - 중복도 없고 탭 간 불일치도 화면에 안 드러나 깔끔하다. */}
          {freshestBadge?.statusBadge && <span className="font-bold">{freshestBadge.statusBadge}</span>}
          {b.aiPickRank && b.aiPickRank <= 5 && <span title={`AI 수급 추천 ${b.aiPickRank}위`}>⭐</span>}

          {/* 수급교집합 탭은 주체별 실제 연속일수 뱃지를 그대로 붙여서 보여준다 */}
          {Array.isArray(b.ranksByType) && b.ranksByType.length > 0 && (
            <span className="flex items-center gap-0.5 ml-0.5">
              {b.ranksByType.map((r) => (
                <span
                  key={r.type}
                  className={`px-1 py-0.5 rounded border text-[9px] font-mono ${entityBadgeColor(r.netBuyAmt)}`}
                >
                  {r.label} {r.consecutiveText || '당일'}
                </span>
              ))}
            </span>
          )}

          {/* 급등주 교집합 전용 문구 */}
          {b.surgingBadge && <span className="opacity-80">{b.surgingBadge}</span>}

          {/* 단타 종합랭킹 점수 */}
          {typeof b.scoreTotal === 'number' && <span className="opacity-80">{b.scoreTotal}점</span>}
        </span>
      ))}
    </div>
  );
}
