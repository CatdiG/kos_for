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
  // 🚨 [기능 추가 - 사용자 요청: "오늘 만든 장마감 후보군도 뱃지모음에 나오게 해줘"] 'supply-postmarket'이
  // 'overlap'으로 시작하지 않지만 'postmarket'으로 시작하는 다른 항목보다 먼저 체크해야
  // "postmarket" 단순 매칭에 걸리지 않는다(아래 postmarket 분기와 순서 무관하게 명확히 구분).
  if (tabId.startsWith('supply-postmarket')) return '수급장마감후보군';
  if (tabId === 'postmarket') return '장마감후보군';
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
// 🚨 [기능 추가 - "수급 장마감 후보군"] 이 소스의 statusBadge는 overlap-3d 계산 결과를 그대로 물려받은
// 것이라(kisApi.ts의 fetchKisSupplyPostMarketCandidates) overlap-3d와 사실상 동일한 신선도다 - 바로
// 뒤에 둔다. postmarket(급등주 기반)은 statusBadge 자체를 계산하지 않는 소스라 이 목록에 넣어도 절대
// 선택되지 않지만(freshnessRank는 b.statusBadge가 있는 항목에만 쓰임), 명시적으로 최하위에 둬 의도를 남긴다.
const FRESHNESS_PRIORITY = ['foreign', 'organ', 'program', 'overlap-daily', 'overlap-2d', 'overlap-3d', 'supply-postmarket', 'postmarket'];
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

  // 🚨 [버그 수정 - 사용자 지적: "단기과열 뱃지 하나만 띄우고 뒤에 다 붙이지 말고"] 이전 버전은
  // freshestBadge 문구를 모든 탭 칩에 각각 반복해서 넣는 바람에, 실제로는 값이 1개인데 칩 개수만큼(예:
  // 7번) 화면에 똑같은 배지가 줄줄이 찍혀 보였다(사용자 스크린샷으로 확인). 이격도 배지는 종목당 딱
  // 하나만, 별도의 단일 칩으로 앞에 한 번만 그린다 - 나머지 탭 칩(급등주/외국인/기관 등)은 원래 목적인
  // "이 종목이 몇 위에 있는지"만 담백하게 보여준다.
  const freshestBadge = [...badges]
    .filter((b) => b.statusBadge)
    .sort((a, b) => freshnessRank(a.tabId) - freshnessRank(b.tabId))[0];

  return (
    // 🚨 [UI 수정] flex-1 하나로 옆 종목명 블록(shrink-0 없음)까지 밀어붙이던 걸,
    // 오른쪽에 명시적 여백(mr-3)을 둬서 뱃지가 아무리 여러 줄로 늘어나도 종목명 영역을 침범하지 않게 한다.
    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 px-1 lg:px-3 mr-3 lg:mr-4">
      {freshestBadge?.statusBadge && (
        <span
          title={`이격도 추세 (${shortSourceLabel(freshestBadge.tabId)} 탭 최신 기준)`}
          className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap ${
            freshestBadge.statusBadgeStyle || DEFAULT_BADGE_STYLE
          }`}
        >
          {freshestBadge.statusBadge}
        </span>
      )}
      {badges.map((b) => (
        <span
          key={b.tabId}
          title={`${b.tabLabel} ${b.rank}위${b.investorBadge ? ` · ${b.investorBadge}` : ''}`}
          className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-bold border whitespace-nowrap ${DEFAULT_BADGE_STYLE}`}
        >
          <span className="opacity-70 font-medium">{b.tabLabel}</span>
          <span>{b.rank}위</span>
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
