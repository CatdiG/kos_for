'use client';

import React, { useState } from 'react';
import { RankingItem, RankingType } from '@/lib/types';
import RankingStockDetailChart from '@/components/RankingStockDetailChart';

interface HistoryRankingTableProps {
  items: RankingItem[];
  type: RankingType;
  isLoading: boolean;
  selectedDate: string;
  onStockClick?: (symbol: string) => void;
  surgingMode?: 'fluctuation' | 'volume' | 'amount' | 'overlap';
  overlapMode?: 'daily' | 'consecutive2d' | 'consecutive3d';
  quietFilter?: boolean;
}

export const HistoryRankingTable: React.FC<HistoryRankingTableProps> = ({
  items,
  type,
  isLoading,
  selectedDate,
  onStockClick,
  surgingMode,
  overlapMode,
  quietFilter,
}) => {
  const isConsecutive = overlapMode === 'consecutive2d' || overlapMode === 'consecutive3d';
  const isSurgingOverlap = type === 'surging' && surgingMode === 'overlap';
  // 🎯 [기능 추가 - 사용자 요청: "장마감 후보군들이 다음날 실제로 상승했는지 보고싶어"] postmarket/watchlist는
  // 순매수금액 개념이 없고(포스트마켓은 급등주 기반, 관심종목은 개별 종목 목록) 대신 거래대금·다음날 결과가
  // 더 유의미하다 - surging/comprehensive와 같은 컬럼 취급으로 묶는다.
  const showAmountColumn = type === 'surging' || type === 'comprehensive' || type === 'postmarket' || type === 'watchlist';
  // 🚨 [기능 추가 - 사용자 요청: "히스토리도 장마감 후보군 업데이트 해줘"] discovery/precursor는 거래대금·
  // 순매수 둘 다 의미 있는 값이 없다(0으로 고정) - 대신 전용 요약 칸(급등 상세 순위와 동일한 자리)을 쓴다.
  const showNetBuyColumn = !showAmountColumn && type !== 'discovery' && type !== 'precursor';
  // 🎯 [기능 추가 - 사용자 요청: "수급교집합 장마감 후보만도... 얼마나 올랐는지 두개 보여주고"] 수급교집합에
  // "장마감 후보만" 토글이 켜져 있을 때도 postmarket과 동일하게 다음날 결과(종가/고가)를 보여준다.
  const showNextDayColumn = type === 'postmarket' || type === 'discovery' || type === 'precursor' || type === 'watchlist' || (type === 'overlap' && Boolean(quietFilter));
  // 🚨 [기능 수정 - 사용자 지적: "장마감 후보군 히스토리는 왜 실시간 내용과 다른거야"] 발굴 탭은 이전엔
  // 매집주체/오후매수세/거래대금배율/눌림저항/상대강도/종합점수 6개를 "매집·강도 요약" 한 칸으로 뭉쳐
  // 보여줬다 - 정작 calculateDiscoveryFromHistory(historyService.ts)는 이 6개 필드를 discovery_snapshots
  // 에서 이미 다 읽어와 RankingItem에 채워주고 있었다(백엔드 데이터는 있었음, 프론트가 안 쓴 것뿐). 라이브
  // 대시보드(InvestorRankingTable.tsx discovery 컬럼)와 동일하게 6개 컬럼으로 풀어서 보여준다(수칙 1-6:
  // 새 계산 없이 이미 있는 필드 그대로 노출).
  const isDiscoveryDetail = type === 'discovery';
  // 🚨 [기능 수정 - 사용자 지적: "전조도 같이 고쳐"] 발굴과 동일한 문제 - calculatePrecursorFromHistory가
  // recentReturnPct/volumeSurgeRatio/volumeTrendIncreasing/priceVolumeDivergence/closeToHighRatioPct/
  // precursorScore 6개를 이미 다 채워주는데 "거래 급증 요약" 한 칸으로 뭉쳐 보여주고 있었다.
  const isPrecursorDetail = type === 'precursor';
  // discovery/precursor는 거래량을 별도로 집계하지 않아(전용 지표 컬럼으로 대체) 이 컬럼이 항상 "-"만
  // 찍혔다 - 라이브 대시보드에도 이 두 탭엔 애초에 "거래량" 컬럼 자체가 없으므로 헤더도 맞춰서 숨긴다.
  const hideVolumeColumn = type === 'discovery' || type === 'precursor';
  const [searchTerm, setSearchTerm] = useState('');
  // 🚨 [기능 수정 - 사용자 지적: "누른 종목밑에 바로 떠야하지않겠니? 지금 로컬에서처럼"] 처음엔 부모
  // (history/page.tsx)가 selectedSymbol을 받아 테이블 "위"에 고정 패널로 차트를 띄웠는데, 실시간
  // 대시보드(InvestorRankingTable.tsx)는 클릭한 행 바로 아래에 아코디언으로 펼친다 - 그 UX를 그대로
  // 맞춘다. 상태를 이 컴포넌트 안에서 자체 관리해서 어느 행 바로 밑에 펼칠지 알 수 있게 한다.
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const filteredItems = items.filter((item) =>
    item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.symbol.includes(searchTerm)
  );

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
      {/* 테이블 상단 컨트롤 바 */}
      <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
            📅 {selectedDate} 확정 데이터
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            총 {filteredItems.length}개 종목
          </span>
        </div>

        <div className="relative">
          <input
            type="text"
            placeholder="종목명/코드 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="text-xs px-3 py-1.5 pl-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48"
          />
          <svg
            className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* 테이블 영역 */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-800/40 text-slate-600 dark:text-slate-400 text-xs font-semibold">
              <th className="py-3 px-4 w-16 text-center">순위</th>
              <th className="py-3 px-4 min-w-[160px]">종목명</th>
              <th className="py-3 px-4 text-right">종가</th>
              <th className="py-3 px-4 text-right">등락률</th>
              {!hideVolumeColumn ? (
                <th className="py-3 px-4 text-right">거래량</th>
              ) : null}
              {showAmountColumn ? (
                <th className="py-3 px-4 text-right">거래대금</th>
              ) : null}
              {type === 'comprehensive' ? (
                <th className="py-3 px-4 text-center">종합점수</th>
              ) : null}
              {showNetBuyColumn ? (
                <th className="py-3 px-4 text-right">순매수금액</th>
              ) : null}
              {type === 'overlap' ? (
                <th className="py-3 px-4 min-w-[200px]">{isConsecutive ? '주체별 연속매매' : '수급 주체'}</th>
              ) : null}
              {isSurgingOverlap ? (
                <th className="py-3 px-4 min-w-[180px]">포착 지표</th>
              ) : null}
              {type === 'postmarket' ? (
                <th className="py-3 px-4 min-w-[220px]">급등 상세 순위</th>
              ) : null}
              {isDiscoveryDetail ? (
                <>
                  <th className="py-3 px-4 min-w-[150px]" title="상승 과정에서 누가 물량을 받았는지(장중 추정)">매집 주체</th>
                  <th className="py-3 px-4 text-right" title="오늘 누적 거래대금 중 14시 이후 비중">오후 매수세</th>
                  <th className="py-3 px-4 text-right" title="오늘 거래대금 ÷ 최근 20거래일 평균">거래대금 배율</th>
                  <th className="py-3 px-4 text-right" title="당일 고가 등락률 대비 현재 등락률 하락폭(0에 가까울수록 고가권 유지)">눌림 저항</th>
                  <th className="py-3 px-4 text-right" title="현재 등락률 - 소속 시장 지수 등락률">상대강도</th>
                  <th className="py-3 px-4 text-center" title="5개 지표 백분위 평균 - 아직 실측 백테스트 전 잠정치">종합점수</th>
                </>
              ) : null}
              {isPrecursorDetail ? (
                // 🚨 [전면 재정의 - "눌림후속"] 기존 4개 지표 점수식은 202거래일 실측에서 다음날 수익률과
                // 상관계수 사실상 0으로 확인돼 제거(수칙 1-7) - 조건2(종가/고가 94~97%)만 추가 표시.
                // 조건1(당일등락률<-0.5%)은 이미 공통 "등락률" 컬럼에 표시됨(수칙 1-6, 중복 컬럼 방지).
                <th className="py-3 px-4 text-right" title="조건2: 94~97% (당일 하락 중 어중간하게 반등도 붕괴도 아닌 위치에서 마감)">종가/고가</th>
              ) : null}
              {showNextDayColumn ? (
                <th className="py-3 px-4 text-right min-w-[130px]" title="raw_daily_data에 실제로 수집된 다음 영업일 종가/고가 기준">
                  다음날 결과
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {isLoading ? (
              <tr>
                <td colSpan={14} className="py-12 text-center text-slate-400 text-sm">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span>과거 확정 데이터를 불러오는 중입니다...</span>
                  </div>
                </td>
              </tr>
            ) : filteredItems.length === 0 ? (
              <tr>
                <td colSpan={14} className="py-12 text-center text-slate-400 text-sm">
                  {type === 'watchlist' ? '등록된 관심종목이 없거나, 이 날짜 원본 데이터가 없습니다.' : `해당 날짜(${selectedDate})의 확정 데이터가 없습니다.`}
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => {
                const isPositive = (item.changeRate || 0) > 0;
                const isNegative = (item.changeRate || 0) < 0;
                const priceColor = isPositive ? 'text-red-500 dark:text-red-400' : isNegative ? 'text-blue-500 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300';

                const isExpanded = expandedSymbol === item.symbol;

                return (
                  <React.Fragment key={item.symbol}>
                  <tr
                    onClick={() => {
                      setExpandedSymbol((prev) => (prev === item.symbol ? null : item.symbol));
                      onStockClick && onStockClick(item.symbol);
                    }}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer ${isExpanded ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : ''}`}
                  >
                    <td className="py-3 px-4 text-center font-bold text-slate-500 dark:text-slate-400">
                      {item.rank}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2 flex-nowrap">
                        <span className="font-semibold text-slate-900 dark:text-slate-100 hover:text-indigo-600 transition-colors whitespace-nowrap shrink-0">
                          {item.name}
                        </span>
                        <span className="text-xs text-slate-400 whitespace-nowrap shrink-0">
                          {item.symbol}
                        </span>
                        {item.market ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap shrink-0 ${
                            item.market === 'KOSPI' ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' : 'bg-green-50 text-green-600 dark:bg-green-950/40 dark:text-green-400'
                          }`}>
                            {item.market}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-slate-800 dark:text-slate-200">
                      {(item.currentPrice || 0).toLocaleString()}원
                    </td>
                    <td className={`py-3 px-4 text-right font-semibold ${priceColor}`}>
                      {isPositive ? '+' : ''}{(item.changeRate || 0).toFixed(2)}%
                    </td>
                    {!hideVolumeColumn ? (
                      <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-400 text-xs">
                        {(item.volume || 0).toLocaleString()}
                      </td>
                    ) : null}
                    {showAmountColumn ? (
                      <td className="py-3 px-4 text-right font-medium text-slate-800 dark:text-slate-200">
                        {item.amountEok ? `${item.amountEok}억` : '-'}
                      </td>
                    ) : null}
                    {type === 'comprehensive' ? (
                      <td className="py-3 px-4 text-center font-bold text-indigo-600 dark:text-indigo-400">
                        {item.scoreBreakdown?.totalScore || '-'}점
                      </td>
                    ) : null}
                    {showNetBuyColumn ? (
                      <td
                        className={`py-3 px-4 text-right font-bold ${
                          (item.netBuyAmtEok || 0) > 0
                            ? 'text-red-500 dark:text-red-400'
                            : (item.netBuyAmtEok || 0) < 0
                            ? 'text-blue-500 dark:text-blue-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {item.netBuyAmtEok !== undefined ? (
                          <span>
                            {item.netBuyAmtEok > 0 ? `+${item.netBuyAmtEok}` : item.netBuyAmtEok}억
                          </span>
                        ) : '-'}
                      </td>
                    ) : null}
                    {type === 'overlap' ? (
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1 flex-nowrap overflow-x-auto scrollbar-none">
                          {(item.ranksByType || []).map((r, idx) => {
                            const isBuySide = r.netBuyAmtEok >= 0;
                            const badgeColor = isBuySide
                              ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/50'
                              : 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-900/50';
                            return (
                              <span
                                key={idx}
                                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium border whitespace-nowrap shrink-0 ${badgeColor}`}
                              >
                                {isConsecutive ? (
                                  <>
                                    <span>{r.label}</span>
                                    <strong className="font-mono">{r.consecutiveText || '당일'}</strong>
                                  </>
                                ) : (
                                  <span>{r.label} ({r.netBuyAmtEok > 0 ? '+' : ''}{r.netBuyAmtEok}억)</span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    ) : null}
                    {isSurgingOverlap ? (
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1 flex-nowrap overflow-x-auto scrollbar-none">
                          {(item.surgingRanks || []).map((r, idx) => (
                            <span
                              key={idx}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-orange-50 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400 font-medium border border-orange-100 dark:border-orange-900/50 whitespace-nowrap shrink-0"
                            >
                              {r.label} {r.rank}위
                            </span>
                          ))}
                        </div>
                      </td>
                    ) : null}
                    {type === 'postmarket' ? (
                      <td className="py-3 px-4 max-w-[240px]">
                        <span className="text-[10px] px-2 py-0.5 rounded-md font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700/50 whitespace-normal leading-snug inline-block">
                          {item.surgingBadge || '-'}
                        </span>
                      </td>
                    ) : null}
                    {isDiscoveryDetail ? (
                      <>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-md font-bold border whitespace-nowrap ${
                              item.absorptionDirection === 'both'
                                ? 'bg-gradient-to-r from-red-600 to-amber-600 text-white border-transparent'
                                : item.absorptionDirection === 'foreign' || item.absorptionDirection === 'organ'
                                ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                            }`}
                          >
                            {item.absorptionBadge || '데이터 없음'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-700 dark:text-slate-300">
                          {item.afternoonVolumeRatioPct != null ? `${item.afternoonVolumeRatioPct.toFixed(1)}%` : '-'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-700 dark:text-slate-300">
                          {item.volumeSurgeRatio != null ? `${item.volumeSurgeRatio.toFixed(2)}배` : '-'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono">
                          {item.pullbackFromHighPct != null ? (
                            <span className={item.pullbackFromHighPct <= 1 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'}>
                              -{item.pullbackFromHighPct.toFixed(2)}%p
                            </span>
                          ) : '-'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono">
                          {item.relativeStrengthPct != null ? (
                            <span className={item.relativeStrengthPct >= 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}>
                              {item.relativeStrengthPct >= 0 ? '+' : ''}{item.relativeStrengthPct.toFixed(2)}%p
                            </span>
                          ) : '-'}
                        </td>
                        <td className="py-3 px-4 text-center font-bold text-slate-900 dark:text-white">
                          {item.discoveryScore != null ? item.discoveryScore.toFixed(1) : '-'}
                        </td>
                      </>
                    ) : null}
                    {isPrecursorDetail ? (
                      <td className="py-3 px-4 text-right font-mono text-slate-700 dark:text-slate-300">
                        {item.closeToHighRatioPct != null ? `${item.closeToHighRatioPct.toFixed(2)}%` : '-'}
                      </td>
                    ) : null}
                    {showNextDayColumn ? (
                      <td className="py-3 px-4 text-right">
                        {item.nextDayChangeRate === undefined ? (
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">미수집</span>
                        ) : (
                          <div className="flex flex-col items-end gap-0.5">
                            <span
                              className={`font-bold ${
                                item.nextDayChangeRate > 0
                                  ? 'text-red-500 dark:text-red-400'
                                  : item.nextDayChangeRate < 0
                                  ? 'text-blue-500 dark:text-blue-400'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                              title={item.nextDayDateLabel ? `${item.nextDayDateLabel} 종가 기준` : undefined}
                            >
                              {item.nextDayChangeRate > 0 ? '+' : ''}{item.nextDayChangeRate.toFixed(2)}%
                            </span>
                            {/* 🎯 [기능 추가 - 사용자 지적: "장마감되고나면 이미 뛰었다가 내려왔을수도
                                있는거잖아?"] 종가만으론 장중 최대 상승폭을 놓친다 - 다음날 고가 기준도 같이 표시 */}
                            {item.nextDayHighChangeRate !== undefined && (
                              <span
                                className="text-[10px] text-amber-600 dark:text-amber-400 font-medium"
                                title={item.nextDayDateLabel ? `${item.nextDayDateLabel} 장중 고가 기준` : undefined}
                              >
                                최고 {item.nextDayHighChangeRate > 0 ? '+' : ''}{item.nextDayHighChangeRate.toFixed(2)}%
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    ) : null}
                  </tr>
                  {/* 🎯 [기능 추가 - 사용자 요청: "종목 누르면 차트도 나왔으면 좋겠는데" + "누른 종목밑에
                      바로 떠야하지않겠니? 지금 로컬에서처럼"] 실시간 대시보드와 동일하게 클릭한 행 바로
                      아래에 아코디언으로 상세 차트를 펼친다. */}
                  {isExpanded && (
                    <tr className="bg-slate-50/60 dark:bg-[#181c27]/60">
                      <td colSpan={14} className="p-3">
                        <RankingStockDetailChart symbol={item.symbol} onClose={() => setExpandedSymbol(null)} />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
