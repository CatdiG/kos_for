'use client';

import React, { useState, useMemo } from 'react';
import { InvestorTrendDay } from '@/lib/types';
import { ArrowUpDown, Table, ArrowUp, ArrowDown, Calendar, Check } from 'lucide-react';

interface InvestorTrendTableProps {
  trend: InvestorTrendDay[];
}

type SortKey =
  | 'date'
  | 'closePrice'
  | 'priceChange'
  | 'foreignNetBuyAmt'
  | 'organNetBuyAmt';

export interface MonthOption {
  offset: number;         // 0: 이번 달, 1: 1개월 전, 2: 2개월 전, 3: 3개월 전
  yearMonth: string;      // YYYYMM (예: 202608)
  year: number;
  month: number;          // 1 ~ 12
  label: string;          // 예: "이번 달 (8월)"
  shortLabel: string;     // 예: "8월"
}

/**
 * 컴퓨터 현재 시각(new Date()) 기준 4개 월별 자동 계산
 */
export function getMonthOptions(): MonthOption[] {
  const options: MonthOption[] = [];
  const now = new Date();

  for (let offset = 0; offset < 4; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const yearMonth = `${year}${String(month).padStart(2, '0')}`;

    let label = '';
    if (offset === 0) {
      label = `이번 달 (${month}월)`;
    } else {
      label = `${offset}개월 전 (${month}월)`;
    }

    options.push({
      offset,
      yearMonth,
      year,
      month,
      label,
      shortLabel: `${month}월`,
    });
  }

  return options;
}

export default function InvestorTrendTable({ trend }: InvestorTrendTableProps) {
  const [viewUnit, setViewUnit] = useState<'amt' | 'qty'>('amt');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedOffset, setSelectedOffset] = useState<number>(0); // 기본값: 0 (이번 달)
  const [showAllMonths, setShowAllMonths] = useState<boolean>(false);

  const monthOptions = useMemo(() => getMonthOptions(), []);
  const selectedMonth = monthOptions[selectedOffset] || monthOptions[0];

  if (!trend || trend.length === 0) return null;

  // Filter by selected month
  const filteredTrend = trend.filter((item) => {
    if (showAllMonths) return true;
    const ym = item.date.replace(/-/g, '').slice(0, 6);
    return ym === selectedMonth.yearMonth;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  const sortedData = [...filteredTrend].sort((a, b) => {
    let valA = a[sortKey] || 0;
    let valB = b[sortKey] || 0;

    if (typeof valA === 'string') {
      return sortOrder === 'asc' ? valA.localeCompare(valB as string) : (valB as string).localeCompare(valA);
    }
    return sortOrder === 'asc' ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
  });

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="w-3 h-3 text-slate-400 dark:text-[#787b86] opacity-50" />;
    return sortOrder === 'asc' ? (
      <ArrowUp className="w-3 h-3 text-red-600 dark:text-red-400" />
    ) : (
      <ArrowDown className="w-3 h-3 text-red-600 dark:text-red-400" />
    );
  };

  const formatCellVal = (amtInMillion: number, qtyInShare: number) => {
    if (viewUnit === 'qty') {
      const isNeg = qtyInShare < 0;
      return `${isNeg ? '' : '+'}${qtyInShare.toLocaleString()} 주`;
    }

    const isNeg = amtInMillion < 0;
    const abs = Math.abs(amtInMillion);
    if (abs >= 100) {
      return `${isNeg ? '-' : '+'}${(abs / 100).toFixed(1)} 억`;
    }
    return `${isNeg ? '-' : '+'}${abs.toLocaleString()} 백만`;
  };

  return (
    <div className="w-full bg-white dark:bg-[#131722] border border-slate-200 dark:border-[#2a2e39] rounded-2xl p-5 shadow-sm dark:shadow-xl transition-colors duration-200 space-y-4">
      {/* Table Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-[#2a2e39]">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 shrink-0">
            <Table className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-base text-slate-900 dark:text-white">일별 상세 수급 데이터</h3>
            <p className="text-xs text-slate-500 dark:text-[#787b86]">
              날짜별 종가, 대비, 외국인 · 기관 수급 내역
            </p>
          </div>
        </div>

        {/* View Unit Toggle (금액 vs 수량) */}
        <div className="flex items-center bg-slate-100 dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] rounded-xl p-0.5 text-xs font-medium self-start sm:self-auto shrink-0">
          <button
            onClick={() => setViewUnit('amt')}
            className={`px-3 py-1 rounded-lg transition cursor-pointer whitespace-nowrap ${
              viewUnit === 'amt'
                ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-xs font-bold'
                : 'text-slate-600 dark:text-[#787b86] hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            금액 (백만/억)
          </button>
          <button
            onClick={() => setViewUnit('qty')}
            className={`px-3 py-1 rounded-md transition cursor-pointer whitespace-nowrap ${
              viewUnit === 'qty'
                ? 'bg-white dark:bg-[#2a2e39] text-slate-900 dark:text-white shadow-xs font-bold'
                : 'text-slate-600 dark:text-[#787b86] hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            수량 (주)
          </button>
        </div>
      </div>

      {/* 📅 기간별 조회 버튼 4개 (자동 월 계산: 이번 달 / 1개월 전 / 2개월 전 / 3개월 전) */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-50 dark:bg-[#1e222d]/60 p-3 rounded-xl border border-slate-200/80 dark:border-[#2a2e39]/50">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none w-full sm:w-auto">
          <span className="text-xs font-semibold text-slate-500 dark:text-[#787b86] mr-1 flex items-center gap-1 shrink-0">
            <Calendar className="w-3.5 h-3.5 text-indigo-500" />
            월별 조회:
          </span>

          {monthOptions.map((opt) => {
            const isSelected = !showAllMonths && selectedOffset === opt.offset;
            return (
              <button
                key={opt.yearMonth}
                onClick={() => {
                  setSelectedOffset(opt.offset);
                  setShowAllMonths(false);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 whitespace-nowrap cursor-pointer border ${
                  isSelected
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                    : 'bg-white dark:bg-[#131722] text-slate-700 dark:text-slate-300 border-slate-200 dark:border-[#2a2e39] hover:bg-slate-100 dark:hover:bg-[#2a2e39]'
                }`}
              >
                {isSelected && <Check className="w-3 h-3 shrink-0" />}
                <span>{opt.label}</span>
              </button>
            );
          })}

          {/* 전체 선택 옵션 */}
          <button
            onClick={() => setShowAllMonths(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap cursor-pointer border ${
              showAllMonths
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 border-transparent shadow-xs font-bold'
                : 'bg-white dark:bg-[#131722] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-[#2a2e39] hover:bg-slate-100 dark:hover:bg-[#2a2e39]'
            }`}
          >
            전체 기간
          </button>
        </div>

        {/* Selected Month Status Indicator */}
        <div className="text-xs text-slate-500 dark:text-[#787b86] font-mono shrink-0">
          {showAllMonths ? (
            <span>전체 {filteredTrend.length}개 거래일 표시 중</span>
          ) : (
            <span>
              <strong className="text-slate-900 dark:text-white">{selectedMonth.shortLabel}</strong> 수급 ({filteredTrend.length}개 거래일 누적)
            </span>
          )}
        </div>
      </div>

      {/* Table Container */}
      {filteredTrend.length === 0 ? (
        <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-[#1e222d]/30 rounded-xl border border-dashed border-slate-200 dark:border-[#2a2e39]">
          <p className="font-medium mb-1">선택하신 {selectedMonth.label} 수급 데이터가 조회된 내역에 포함되어 있지 않습니다.</p>
          <p className="text-[11px] text-slate-400">상단 차트 기간을 60D로 선택하시거나 [전체 기간] 버튼을 눌러 이전 달 데이터를 확인하실 수 있습니다.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#2a2e39]">
          <table className="w-full text-left text-xs font-mono border-collapse">
            <thead>
              <tr className="bg-slate-100/80 dark:bg-[#1e222d] text-slate-600 dark:text-[#787b86] border-b border-slate-200 dark:border-[#2a2e39]">
                <th
                  onClick={() => handleSort('date')}
                  className="py-3 px-4 font-semibold cursor-pointer hover:text-slate-900 dark:hover:text-white transition select-none"
                >
                  <div className="flex items-center gap-1.5">
                    <span>날짜</span>
                    {renderSortIcon('date')}
                  </div>
                </th>

                <th
                  onClick={() => handleSort('closePrice')}
                  className="py-3 px-4 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white transition select-none"
                >
                  <div className="flex items-center justify-end gap-1.5">
                    <span>종가 (원)</span>
                    {renderSortIcon('closePrice')}
                  </div>
                </th>

                <th
                  onClick={() => handleSort('priceChange')}
                  className="py-3 px-4 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white transition select-none"
                >
                  <div className="flex items-center justify-end gap-1.5">
                    <span>전일대비</span>
                    {renderSortIcon('priceChange')}
                  </div>
                </th>

                <th
                  onClick={() => handleSort('foreignNetBuyAmt')}
                  className="py-3 px-4 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white transition select-none text-red-600 dark:text-red-400"
                >
                  <div className="flex items-center justify-end gap-1.5">
                    <span>외국인 순매수</span>
                    {renderSortIcon('foreignNetBuyAmt')}
                  </div>
                </th>

                <th
                  onClick={() => handleSort('organNetBuyAmt')}
                  className="py-3 px-4 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white transition select-none text-blue-600 dark:text-blue-400"
                >
                  <div className="flex items-center justify-end gap-1.5">
                    <span>기관 순매수</span>
                    {renderSortIcon('organNetBuyAmt')}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-[#2a2e39]/60">
              {sortedData.map((row) => {
                const isPriceUp = row.priceChange > 0;
                const isPriceDown = row.priceChange < 0;

                return (
                  <tr
                    key={row.date}
                    className="hover:bg-slate-50/80 dark:hover:bg-[#1e222d]/60 transition-colors"
                  >
                    {/* 날짜 */}
                    <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                      {row.formattedDate || row.date}
                    </td>

                    {/* 종가 */}
                    <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                      {row.closePrice.toLocaleString()} 원
                    </td>

                    {/* 전일 대비 및 등락률 */}
                    <td className="py-3 px-4 text-right">
                      <div className="flex flex-col items-end">
                        <span
                          className={`font-semibold ${
                            isPriceUp
                              ? 'text-red-600 dark:text-red-400'
                              : isPriceDown
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {isPriceUp ? '+' : ''}
                          {row.priceChange.toLocaleString()}
                        </span>
                        <span
                          className={`text-[10px] ${
                            isPriceUp
                              ? 'text-red-500'
                              : isPriceDown
                              ? 'text-blue-500'
                              : 'text-slate-400'
                          }`}
                        >
                          ({isPriceUp ? '+' : ''}
                          {row.changeRate.toFixed(2)}%)
                        </span>
                      </div>
                    </td>

                    {/* 외국인 순매수 */}
                    <td
                      className={`py-3 px-4 text-right font-bold ${
                        row.foreignNetBuyAmt >= 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-blue-600 dark:text-blue-400'
                      }`}
                    >
                      {formatCellVal(row.foreignNetBuyAmt, row.foreignNetBuyQty)}
                    </td>

                    {/* 기관 순매수 */}
                    <td
                      className={`py-3 px-4 text-right font-bold ${
                        row.organNetBuyAmt >= 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-blue-600 dark:text-blue-400'
                      }`}
                    >
                      {formatCellVal(row.organNetBuyAmt, row.organNetBuyQty)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
