export interface StockInfo {
  symbol: string;
  name: string;
  market: string;
  currentPrice: number;
  change: number;
  changeRate: number;
  volume: number;
  highPrice?: number;
  lowPrice?: number;
  isCreditAvailable?: boolean;
}

export interface InvestorTrendDay {
  date: string;              // YYYYMMDD or YYYY-MM-DD
  stck_bsop_date?: string;   // KIS API raw date field
  formattedDate: string;     // MM.DD
  openPrice?: number;        // 시가
  highPrice?: number;        // 고가
  lowPrice?: number;         // 저가
  closePrice: number;        // 종가
  priceChange: number;       // 전일 대비
  changeRate: number;        // 대비율 (%)
  volume: number;            // 거래량

  // 외국인 (Foreigner)
  foreignNetBuyQty: number;   // 외국인 순매수 수량 (주)
  foreignNetBuyAmt: number;   // 외국인 순매수 금액 (백만원 / 원)

  // 기관 (Institution)
  organNetBuyQty: number;     // 기관 순매수 수량 (주)
  organNetBuyAmt: number;     // 기관 순매수 금액 (백만원 / 원)

  // 연기금 (Pension Fund)
  pensionNetBuyQty: number;   // 연기금 순매수 수량 (주)
  pensionNetBuyAmt: number;   // 연기금 순매수 금액 (백만원 / 원)

  // 프로그램 매매 (Program Trading)
  programNetBuyQty?: number;  // 프로그램 순매수 수량 (주)
  programNetBuyAmt?: number;  // 프로그램 순매수 금액 (백만원 / 원)

  // 누적 수급 금액 (선택된 기간 기준)
  cumForeignNetBuyAmt?: number;
  cumOrganNetBuyAmt?: number;
  cumPensionNetBuyAmt?: number;
  cumProgramNetBuyAmt?: number;
}

export interface InvestorMetricSummary {
  todayEstimateAmt: number;   // 당일 추정 순매수 금액
  todayEstimateQty: number;   // 당일 추정 순매수 수량
  net5d: number;              // 5일 누적 순매수
  net20d: number;             // 20일 누적 순매수
  net60d: number;             // 60일 누적 순매수
  status: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  isFallback?: boolean;       // 당일 미집계로 인한 직전 유효일 폴백 사용 여부
  asOfDateLabel?: string;     // 기준일 라벨 (예: "(8/27 기준)" 또는 "당일 가집계")
}

export interface SupplySummary {
  foreign: InvestorMetricSummary;
  organ: InvestorMetricSummary;
  pension: InvestorMetricSummary;
  program?: InvestorMetricSummary;
}

export type TrendPeriod = '5d' | '20d' | '60d';

export interface ProgramTradeIntradayPoint {
  time: string;               // 시간 (HH:MM)
  price: number;              // 현재가
  arbitrageAmt: number;       // 차익 순매수 금액 (백만원)
  nonArbitrageAmt: number;    // 비차익 순매수 금액 (백만원)
  totalNetBuyAmt: number;     // 전체 프로그램 순매수 금액 (백만원)
  totalNetBuyQty: number;     // 전체 프로그램 순매수 수량 (주)
}

export interface ProgramTradeSummary {
  arbitrageAmt: number;       // 당일 차익 순매수 금액 (백만원)
  nonArbitrageAmt: number;    // 당일 비차익 순매수 금액 (백만원)
  totalNetBuyAmt: number;     // 당일 전체 프로그램 순매수 금액 (백만원)
  totalNetBuyQty: number;     // 당일 전체 프로그램 순매수 수량 (주)
  ratioVsVolume: number;      // 거래량 대비 프로그램 매매 비중 (%)
  status: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  intradayTrend: ProgramTradeIntradayPoint[]; // 장중 시간대별 수급 추이
  isFallback?: boolean;
  asOfDateLabel?: string;
}

export interface InvestorTrendResponse {
  stockInfo: StockInfo;
  period: TrendPeriod;
  trend: InvestorTrendDay[];
  summary: SupplySummary;
  programTrade?: ProgramTradeSummary;
  isMock?: boolean;
  mockReason?: string;
  message?: string;
  updatedAt: string;
}

export type MarketType = 'ALL' | 'KOSPI' | 'KOSDAQ';
export type RankingType = 'foreign' | 'organ' | 'pension' | 'program' | 'overlap' | 'surging' | 'comprehensive';
export type RankingDirection = 'buy' | 'sell';
export type RankingPeriod = '1d' | '1w' | '1m' | 'consecutive2d' | 'consecutive3d';
export type SurgingMode = 'fluctuation' | 'volume' | 'amount' | 'overlap' | 'comprehensive';

export interface ScoreBreakdown {
  totalScore: number;         // 0 ~ 100
  flucScore: number;          // 등락률 점수 (0 ~ 100)
  amtScore: number;           // 거래대금 점수 (0 ~ 100)
  volIncScore: number;        // 당일 거래량 절대치 점수 (0 ~ 100)
  volScore?: number;          // 거래량 점수 별칭
  foreignScore: number;       // 외국인 수급 점수 (0 ~ 100, 랭킹 외=50)
  organScore: number;         // 기관 수급 점수 (0 ~ 100, 랭킹 외=50)
  trendAlignScore: number;    // 정배열 이격도 추세 점수 (0 ~ 100)
  closeStrengthScore: number; // 당일 캔들 마감 강도 점수 (0 ~ 100)
  flucRank: number;           // 후보군 내 등락률 순위
  amtRank: number;            // 후보군 내 거래대금 순위
  volIncRank: number;         // 후보군 내 당일 거래량 순위
  volRank?: number;           // 거래량 순위 별칭
  foreignRank: number | null; // 외국인 순위 (null: 랭킹 외)
  organRank: number | null;   // 기관 순위 (null: 랭킹 외)
  trendAlignRank: number;     // 후보군 내 정배열 이격 순위
  closeStrengthRank: number;  // 후보군 내 당일 캔들 강도 순위
}

export interface RankingItem {
  rank: number;
  symbol: string;
  name: string;
  market?: string;
  currentPrice: number;
  change: number;
  changeRate: number;
  netBuyQty: number;          // 순매수(도) 수량 (주)
  netBuyAmt: number;          // 순매수(도) 대금 (백만원)
  netBuyAmtEok: number;       // 순매수(도) 대금 (억원)
  volume: number;             // 전체 거래량 (주)
  ratioVsVolume: number;      // 거래대금 대비 수급 비중 (%)
  amountEok?: number;         // 거래대금 (억원)
  volumeIncreaseRate?: number;// 전일 대비 거래량 증가율 (%)
  openPrice?: number;         // 당일 시가 (원)
  highPrice?: number;         // 당일 고가 (원)
  lowPrice?: number;          // 당일 저가 (원)
  surgingMode?: SurgingMode;  // 급등주 정렬 모드
  surgingModes?: string[];    // 급등주 교집합 탭 전용 교집합 사유 (등락률, 거래량, 거래대금)
  surgingRanks?: SurgingRankItem[]; // 급등주 항목별(등락률, 거래량, 거래대금) 상세 순위
  surgingBadge?: string;      // 급등주 교집합 뱃지 문구 (예: "등락 3위 · 거래량 12위")
  scoreBreakdown?: ScoreBreakdown; // 단타 종합랭킹 탭 전용 5개 세부 점수 분해
  foreignSupplyBadge?: string;// 급등주 교집합 전용 외국인 수급 문구 (예: "외국인 12위 (+482억)" / "랭킹 외")
  organSupplyBadge?: string;  // 급등주 교집합 전용 기관 수급 문구 (예: "기관 5위 (+120억)" / "랭킹 외")
  foreignSupplyDirection?: 'buy' | 'sell' | 'none';
  organSupplyDirection?: 'buy' | 'sell' | 'none';
  isCreditAvailable?: boolean; // 신용거래 가능 여부 (true: 가능, false: 불가능)
  type?: RankingType;         // 랭킹 데이터의 투자자 유형
  foreignNetBuyAmt?: number;  // 외국인 순매수 금액 (백만원)
  organNetBuyAmt?: number;    // 기관 순매수 금액 (백만원)
  pensionNetBuyAmt?: number;  // 연기금 순매수 금액 (백만원)
  programNetBuyAmt?: number;  // 프로그램 순매수 금액 (백만원)
  overlapCount?: number;      // 수급 교집합 탭 전용 중복 주체 수
  investorBadge?: string;     // 수급 교집합 탭 전용 뱃지 문구
  statusBadge?: string;       // 이격도 추세 뱃지 (예: "🔵 바닥 반등")
  statusBadgeStyle?: string;  // 이격도 추세 뱃지 스타일
  ranksByType?: OverlapInvestorRank[];
  missingEntities?: Array<{ type: 'foreign' | 'organ' | 'pension' | 'program'; label: string }>;
  asOfDateLabel?: string;
  aiPickRank?: number;        // AI 추천 순위 배지 (1, 2, 3, 4, 5)
}

export interface SurgingRankItem {
  type: 'fluctuation' | 'volume' | 'amount';
  label: string;
  rank: number;
}

export interface OverlapInvestorRank {
  type: 'foreign' | 'organ' | 'pension' | 'program';
  label: string;
  rank: number;
  isRanked?: boolean;
  netBuyAmt: number;
  netBuyAmtEok: number;
  asOfDateLabel?: string;
  consecutiveDays?: number;
  consecutiveText?: string;
}

export interface OverlapRankingItem extends RankingItem {
  overlapCount: number;
  investorLabels: string[];
  investorBadge: string;
  totalNetBuyAmt: number;
  totalNetBuyAmtEok: number;
  ranksByType: OverlapInvestorRank[];
}

export interface InvestorRankingResponse {
  type: RankingType;
  direction: RankingDirection;
  period: RankingPeriod;
  list: RankingItem[];
  overlapList?: OverlapRankingItem[];
  isMock?: boolean;
  mockReason?: string;
  lastBatchTime?: string;     // 연기금/프로그램 탭용 배치 시각 (예: "11:30 기준")
  updatedAt: string;
  auditLog?: any;
}

export interface KisTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  access_token_token_expired?: string;
}

export function isEtfOrEtn(name: string): boolean {
  if (!name) return false;
  const upper = name.toUpperCase();
  const keywords = [
    'KODEX', 'TIGER', 'SOL', 'ACE', 'RISE', 'KBSTAR', 'ARIRANG', 'HANARO',
    'KOSEF', 'FOCUS', 'WOORI', 'TIMEFOLIO', 'HERO', 'PLUS', 'UNIFEX', 'TREX',
    'ETN', 'ETF', '레버리지', '인버스', '선물', '2X', '3X'
  ];
  return keywords.some((kw) => upper.includes(kw));
}
