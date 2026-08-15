import { ArrowUpRight, ArrowDownRight, ArrowRight } from 'lucide-react';

/**
 * 매수/매도 수급 판별 기준 임계값 (백만원 단위)
 * 0 초과: 매수, 0 미만: 매도, 0: 관망/중립
 */
export const SUPPLY_THRESHOLD = 0;

export type SupplyDirection = 'BUY' | 'SELL' | 'NEUTRAL';

export interface SupplyDirectionInfo {
  direction: SupplyDirection;
  label: string;             // '매수 우위' | '매도 우위' | '관망·중립'
  badgeLabel: string;        // '순매수' | '순매도' | '관망·중립'
  colorClass: string;        // 텍스트 색상
  bgClass: string;           // 뱃지 배경/텍스트/테두리 스타일
  borderColorClass: string;  // 카드 아이콘 및 테두리 스타일
  Icon: typeof ArrowUpRight;
}

export function getSupplyDirection(
  amount: number,
  threshold: number = SUPPLY_THRESHOLD
): SupplyDirectionInfo {
  if (amount > threshold) {
    return {
      direction: 'BUY',
      label: '매수 우위',
      badgeLabel: '순매수',
      colorClass: 'text-red-600 dark:text-red-400',
      bgClass: 'bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/60',
      borderColorClass: 'border-red-200 dark:border-red-800/40',
      Icon: ArrowUpRight,
    };
  }

  if (amount < -threshold) {
    return {
      direction: 'SELL',
      label: '매도 우위',
      badgeLabel: '순매도',
      colorClass: 'text-blue-600 dark:text-blue-400',
      bgClass: 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60',
      borderColorClass: 'border-blue-200 dark:border-blue-800/40',
      Icon: ArrowDownRight,
    };
  }

  return {
    direction: 'NEUTRAL',
    label: '관망·중립',
    badgeLabel: '관망·중립',
    colorClass: 'text-slate-500 dark:text-gray-400',
    bgClass: 'bg-slate-100 dark:bg-gray-800 text-slate-600 dark:text-gray-400 border-slate-200 dark:border-gray-700',
    borderColorClass: 'border-slate-200 dark:border-gray-700',
    Icon: ArrowRight,
  };
}
