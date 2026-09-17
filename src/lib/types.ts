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

  // 프로그램 매매 (Program Trading)
  programNetBuyQty?: number;  // 프로그램 순매수 수량 (주)
  programNetBuyAmt?: number;  // 프로그램 순매수 금액 (백만원 / 원)

  // 누적 수급 금액 (선택된 기간 기준)
  cumForeignNetBuyAmt?: number;
  cumOrganNetBuyAmt?: number;
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
  program?: InvestorMetricSummary;
}

export type TrendPeriod = '5d' | '20d' | '60d';

export interface ProgramTradeIntradayPoint {
  time: string;               // 시간 (HH:MM)
  price: number;              // 현재가
  totalNetBuyAmt: number;     // 전체 프로그램 순매수 금액 (백만원)
  totalNetBuyQty: number;     // 전체 프로그램 순매수 수량 (주)
}

// 🚨 [버그 수정 - 수칙 1-3: 가상 비율 금지] 종목별 프로그램매매 TR(FHPPG04650101/0200)은 전체 합산
// (whol_smtn_ntby_*)만 제공하고 차익/비차익 구분 필드를 주지 않는다. 예전엔 arbitrageAmt/
// nonArbitrageAmt를 항상 15:85(또는 UI 폴백은 10:90)로 임의 분할해서 보여줬는데, 이는 실제 KIS
// 데이터가 아니라 완전히 지어낸 숫자였다 - 필드 자체를 제거해 더 이상 가짜 분할값을 만들지 않는다.
export interface ProgramTradeSummary {
  totalNetBuyAmt: number;     // 당일 전체 프로그램 순매수 금액 (백만원)
  totalNetBuyQty: number;     // 당일 전체 프로그램 순매수 수량 (주)
  ratioVsVolume: number;      // 거래량 대비 프로그램 매매 비중 (%) - 실시간 TR에 거래량 필드가 없어 산출 불가 시 0
  status: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL';
  intradayTrend: ProgramTradeIntradayPoint[]; // 장중 시간대별 수급 추이
  isFallback?: boolean;
  asOfDateLabel?: string;
}

export interface IntradayCandlePoint {
  time: string; // "15:30", "15:27" ...
  rawTime: string; // "153000"
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  ma5?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  vwap?: number | null; // 당일 거래량가중평균가 - 하루 시작 시점부터 누적, 날짜 바뀌면 리셋
  vwapUpper1?: number | null; // VWAP + 1표준편차
  vwapLower1?: number | null; // VWAP - 1표준편차
  vwapUpper2?: number | null; // VWAP + 2표준편차
  vwapLower2?: number | null; // VWAP - 2표준편차
}

export interface IntradayPivotFibonacciLevels {
  pivot: {
    r2: number; // 피봇 2차 저항 (신고가 영역)
    r1: number; // 피봇 1차 저항 (2차 익절선)
    p: number;  // 피봇 중심선 (강세/약세 기준선)
    s1: number; // 피봇 1차 지지 (과매도 지지선)
    s2: number; // 피봇 2차 지지
  };
  fibonacci: {
    fibo236: number; // 23.6% 초강세 지지선
    fibo382: number; // 38.2% 최적 단타 매수 타점
    fibo500: number; // 50.0% 손절 마지노선
    fibo618: number; // 61.8% 추세 경계선
  };
  daySummary: {
    high: number;
    low: number;
    close: number;
    range: number;
  };
}

export interface IntradayChartResponse {
  symbol: string;
  name: string;
  timeUnit: '3m' | '1m' | '5m';
  candles: IntradayCandlePoint[];
  levels: IntradayPivotFibonacciLevels;
  totalCount?: number;
  todayCount?: number;
  prevCount?: number;
  statusNotice?: string;
  isMock?: boolean;
  updatedAt: string;
}

// 당일 3분봉(VWAP 필드 포함, IntradayCandlePoint 재사용)에서 "직전 VWAP 이탈 → 재돌파 + 거래량 재증가"
// 조합을 온디맨드로 판정한 결과 - 급등주/수급교집합 후보 목록에서 "지금 재상승 시도가 신뢰할 만한가"를
// 사용자가 버튼으로 눌러서 확인할 때 쓴다(사용자 요청: "거래량이랑 VWAP 재돌파, 코드로 자동 체크").
// 🚨 [기능 보강 - 사용자 지적: "이미 재돌파 하고나면 내가 또 못사잖아"] signal(reclaimed+volSurge)만
// 있으면 이미 다 오른 뒤에야 뜨는 후행 지표라 매수 타이밍을 놓친다. approaching을 추가해 "아직 안
// 뚫었지만 간격이 좁혀지고 거래량이 먼저 붙기 시작한" 선행 상태를 별도로 구분한다.
export interface VwapReclaimSignal {
  symbol: string;
  signal: boolean; // 확정(후행): reclaimed && volSurge - 이미 돌파가 끝난 뒤라 참고용
  reclaimed: boolean; // 직전 봉 VWAP 아래 → 돌파 봉 VWAP 위 → 최신 봉까지 유지
  volSurge: boolean; // 돌파 봉 거래량이 돌파 직전 4개 봉 평균 거래량보다 높음
  approaching: boolean; // 선행(액션 가능): 아직 미돌파 + 간격이 좁혀짐 + 임박(0.5% 이내) + 거래량 선행 증가(완결봉 기준)
  hadPriorReclaim: boolean; // 오늘 이미 2번 이상 below→above 전환이 있었음 - "한 번 뚫었다가 다시 뚫으려는 재시도"
  crossCount: number; // 오늘 below→above 전환 누적 횟수(원본 숫자) - 4회 이상이면 "잦은 등락"(VWAP
  // 근처 노이즈성 등락)으로 분류해 신뢰도 낮은 신호로 별도 표시한다(사용자 확인: 실측 90 백분위수=4)
  insufficientData: boolean; // 오늘 3분봉이 8개 미만이라 판정 불가(장 시작 직후 등)
}

// 🎯 [기능 추가 - 사용자 요청: "R2까지 안가고 R1까지 뚫었어도 괜찮아... 손절선에 가도 괜찮아... 다시
// 올라올거 같은 반등"] 전일 확정 일봉 기준 고정 피봇 저항선(R1·R2)을 뚫었다가(깊이 상관없이) 다시 그
// 선을 향해 올라오는 종목을 잡는다 - VWAP 재돌파와 판정 로직은 동일(간격 좁혀짐+거래량 선행)하지만
// 기준선이 계속 움직이는 VWAP 대신 하루 종일 고정인 R1/R2라는 점이 다르다.
export interface PivotLevelSignal {
  reclaimed: boolean; // 뚫은 적 있고(hasBroken) + 그 뒤 한 번이라도 밑으로 갔었고(hasBeenBelowAfterBreak) + 지금 다시 위
  approaching: boolean; // 위 조건 + 지금은 밑인데 간격 좁혀짐 + 1.5% 이내 임박 + 거래량 선행 증가
  volSurge: boolean; // 최근 표본 창 안에서 재돌파 시점의 거래량 증가가 확인됐는지(창 밖이면 미확인)
  hadPriorBreak: boolean; // 오늘 이 선을 뚫었다가 다시 밑으로 내려간 적 있음 - reclaimed/approaching이 둘 다
  // false여도 이 값이 true면 "이전 이력만 있음"(대기 중, VWAP의 hadPriorReclaim과 동일한 목적)
}
export interface PivotReclaimSignal {
  symbol: string;
  r1: PivotLevelSignal;
  r2: PivotLevelSignal; // r2가 걸려있으면 r1은 이미 걸려있는 게 자연스러움(R2가 R1보다 위)
  insufficientData: boolean;
}

// ============================================================================
// KOSPI/KOSDAQ 지수 일봉 차트 전용 타입
// - 지수는 개별 종목과 달리 "외국인/기관/프로그램 순매수" 개념이 KIS API에 존재하지 않아
//   InvestorTrendDay/InvestorTrendResponse를 그대로 재사용하지 않고 필요한 필드만 별도 정의한다
//   (수칙 1-3: 없는 데이터를 0으로 채워 있는 것처럼 꾸미지 않는다).
// ============================================================================
export interface IndexTrendDay {
  date: string;          // YYYYMMDD
  formattedDate: string; // MM.DD
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  tradingValueEok?: number; // 거래대금(억원)
}

export interface IndexInfo {
  code: '0001' | '1001';
  name: string; // '코스피' | '코스닥'
  currentPrice: number;
  change: number;
  changeRate: number;
  // 🚨 [버그 수정 - 사용자 지적: 음봉인데 +로 표시] change/changeRate의 부호를 프론트가 다시 역산해서
  // "양봉/음봉"을 판정하던 방식(change >= 0)이, KIS 원본 필드 부호 이중 반전 버그와 맞물려 잘못된 방향을
  // 표시하는 근본 원인이었다. KIS가 이미 직접 내려주는 prdy_vrss_sign(1·2=상승, 3=보합, 4·5=하락)을
  // 백엔드에서 그대로 판정해 내려보내, 프론트는 값의 부호를 다시 추론하지 않고 이 필드만 신뢰하면 된다.
  isUp: boolean;
  volume: number;
  tradingValueEok?: number;
  advancingCount?: number;
  decliningCount?: number;
  unchangedCount?: number;
}

export interface IndexTrendResponse {
  indexInfo: IndexInfo;
  period: TrendPeriod;
  trend: IndexTrendDay[];
  isMock?: boolean;
  message?: string;
  updatedAt: string;
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
export type RankingType = 'foreign' | 'organ' | 'program' | 'overlap' | 'surging' | 'comprehensive' | 'postmarket' | 'watchlist';
export type RankingDirection = 'buy' | 'sell';
export type RankingPeriod = '1d' | '1w' | '1m' | 'consecutive2d' | 'consecutive3d';
export type SurgingMode = 'fluctuation' | 'volume' | 'amount' | 'overlap' | 'comprehensive' | 'postmarket';

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
  programNetBuyAmt?: number;  // 프로그램 순매수 금액 (백만원)
  overlapCount?: number;      // 수급 교집합 탭 전용 중복 주체 수
  investorBadge?: string;     // 수급 교집합 탭 전용 뱃지 문구
  statusBadge?: string;       // 이격도 추세 뱃지 (예: "🔵 바닥 반등")
  statusBadgeStyle?: string;  // 이격도 추세 뱃지 스타일
  ranksByType?: OverlapInvestorRank[];
  missingEntities?: Array<{ type: 'foreign' | 'organ' | 'program'; label: string }>;
  asOfDateLabel?: string;
  aiPickRank?: number;        // AI 추천 순위 배지 (1, 2, 3, 4, 5)
  firstSeenAt?: string;       // 당일 교집합 탭 전용: 이 종목이 오늘 처음 교집합 명단에 포착된 시각(ISO)
  firstSeenLabel?: string;    // firstSeenAt을 "HH:MM 최초포착" 형태로 가공한 표시용 문구
  // 급등주 탭 "장마감 후보군"(postmarket) 서브모드 전용 - 다음 거래일 시가 R2 돌파 후보를 가리기 위한
  // 당일 캔들 형태 지표. R2 = 종가+(고가-저가)이므로 todayRangePct가 좁을수록 다음날 R2까지 거리가 가깝다.
  todayRangePct?: number;     // 당일 변동폭 (고가-저가)/종가 * 100 (%) - 낮을수록 R2 근접
  closePositionPct?: number;  // 당일 저가~고가 구간에서 종가의 위치 (%) - 100에 가까울수록 고가권 마감
  postMarketScore?: number;   // 위 지표 + 급등주 교집합 개수 + 기관 수급 상태를 합산한 종합 점수(내부 정렬용)
  // 🚨 [기능 추가 - "장마감 후보만" 토글] 수급교집합(당일/2일연속/3일연속) 위에 얹는 역발상 필터 전용 -
  // scratch 백테스트(96거래일 실측)로 검증된 결과, closePositionPct는 "낮을수록"(저가마감), 아래 두
  // 지표도 "낮을수록"(조용한 거래량 · 최근 눌림) 다음날 수익률이 좋았다 - 기존 postMarketScore의 "고가
  // 마감·변동폭 좁음이 좋다"는 가정과 정반대 결과라 별도 필드로 분리했다(수칙 1-3 - 검증 안 된 가정 재사용 금지).
  volRatioPct?: number;       // 당일 거래량 / 최근 5거래일 평균거래량 * 100 (%) - 낮을수록(조용할수록) 유리
  cum5dReturnPct?: number;    // 최근 5거래일 누적수익률(오늘 포함, %) - 낮을수록(최근 눌려있을수록) 유리
  // 🎯 [기능 추가 - 사용자 요청: "장마감 후보군들이 다음날 실제로 상승했는지 보고싶어"] 히스토리 탭
  // 전용 - raw_daily_data에 실제로 수집된 "다음 영업일" 종가와 비교한 실측 결과. 아직 다음날 데이터가
  // 수집 안 됐으면(가장 최근 거래일 등) undefined로 남는다(가짜 0%로 채우지 않음 - 수칙 1-3).
  nextDayChangeRate?: number; // 다음 영업일 종가 기준 등락률 (%) - (다음날 종가-당일 종가)/당일 종가*100
  nextDayDateLabel?: string;  // 그 다음 영업일 날짜 표시용 (예: "9/18")
  // 🎯 [기능 추가 - 사용자 지적: "장마감되고나면 이미 뛰었다가 내려왔을수도 있는거잖아?"] 다음날 종가만
  // 보면 장중 한때 크게 뛰었다가 밀려서 종가는 밋밋해진 경우를 놓친다 - 다음 영업일 "고가" 기준 등락률도
  // 함께 보여줘 "장중 최대로 얼마나 갔었는지"를 알 수 있게 한다(nextDayChangeRate와 동일한 raw_daily_data
  // 소스, high_price 컬럼만 다르게 사용 - 수칙 1-6).
  nextDayHighChangeRate?: number; // 다음 영업일 고가 기준 등락률 (%) - (다음날 고가-당일 종가)/당일 종가*100
}

export interface SurgingRankItem {
  type: 'fluctuation' | 'volume' | 'amount';
  label: string;
  rank: number;
}

export interface OverlapInvestorRank {
  type: 'foreign' | 'organ' | 'program';
  label: string;
  rank: number;
  isRanked?: boolean;
  netBuyAmt: number;
  netBuyAmtEok: number;
  asOfDateLabel?: string;
  consecutiveDays?: number;
  consecutiveText?: string;
  isDailyBuy?: boolean;
}

// ============================================================================
// 종목 검색 옆 "전 탭 뱃지 모음" 전용 타입 - 현재 존재하는 모든 랭킹 탭(급등주/단타종합랭킹/외국인/기관/
// 프로그램/수급교집합 당일·2일연속·3일연속)의 캐시에서 해당 종목이 있으면 그 탭의 뱃지를 그대로 모아온다.
// ============================================================================
export interface StockBadgeItem {
  tabId: string;       // 예: 'surging-fluctuation', 'overlap-consecutive2d-buy'
  tabLabel: string;    // 화면 표시용 탭 이름, 예: "급등주(등락률)"
  rank: number;
  // 아래는 각 탭의 원본 RankingItem 필드를 그대로 넘긴다 - 프론트(StockBadgeStrip.tsx)가 각 탭에서
  // 이미 쓰던 뱃지 JSX/스타일을 그대로 재사용해서 그리도록, 가공하지 않고 원본 그대로 전달한다.
  statusBadge?: string;
  statusBadgeStyle?: string;
  surgingBadge?: string;
  investorBadge?: string;
  netBuyAmtEok?: number;
  scoreTotal?: number;
  aiPickRank?: number;
  ranksByType?: OverlapInvestorRank[];
  // 🚨 [기능 추가 - 사용자 요청: 탭마다 배지 다를 때 기준 시각 표시] 탭마다 statusBadge가 서로 다른
  // 시점의 캐시 스냅샷을 기반으로 계산될 수 있다(수칙 1-5와 동일 취지 - 대체 데이터엔 기준을 밝힌다).
  // 각 탭이 이미 갖고 있는 asOfDateLabel(예: "당일 가집계 (12:01 기준)")을 그대로 실어보내 프론트가
  // "이 배지가 몇 시 기준 데이터인지" 보여줄 수 있게 한다.
  asOfDateLabel?: string;
}

export interface StockBadgeSummaryResponse {
  symbol: string;
  name: string;
  market?: string;
  badges: StockBadgeItem[];
  updatedAt: string;
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
  lastBatchTime?: string;     // 프로그램 탭용 배치 시각 (예: "11:30 기준")
  asOfDateLabel?: string;     // 당일 가집계/정산 기준일 라벨
  error?: string;
  updatedAt: string;
  auditLog?: any;
  isPartial?: boolean; // 2일/3일연속 교집합 전용: 상위 후보 우선 계산 결과라 백그라운드에서 전체 계산이 이어지고 있음을 표시
  stillWarming?: boolean; // program 탭 전용: 콜드스타트 더미 시그니처(changeRate 0 + volume 1000000)가 응답 목록에 아직 남아있어
  // trend5dBatchStore 백그라운드 예열(after() 25종목/사이클)이 계속 필요함을 표시. 프론트가 이 값이 true인 동안만
  // 짧게 재조회해서(isPartial과 동일 패턴) 예열이 끝나는 대로 화면이 자동으로 정상화되게 한다.
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
