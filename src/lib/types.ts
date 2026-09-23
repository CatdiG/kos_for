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
// 🎯 [기능 재설계 - 사용자 요청: "가격 cross → 가격 cross + 일정 시간 유지", "거래량을 재돌파의 필수
// 조건으로 만들지는 않게 - 가격: 재돌파 판정의 본체, 거래량: 재돌파의 신뢰도"] reclaimed(즉시)는 거래량과
// 무관하게 그대로 즉시 뜨고, elapsedMs(신선도)로 "방금 확인/유지 중/오래된 완료"를 구분한다.
// 🚨 [버그 수정 - 사용자 지적: "뭔 다 확인 불가라고 떠?"] 예전엔 "실시간으로 직접 관측한 돌파 시점"이
// 없으면(감시 시작 전에 이미 돌파해 있었던 흔한 경우) timingKnown을 영구히 false로 묶어놔서 대부분의
// 종목이 계속 "확인불가"로만 떴다 - breakoutTs를 아예 못 구하는 게 아니라, "우리가 관측을 시작한
// 시점"을 하한(최소 이만큼은 유지됨)으로 삼으면 되는데 그걸 null로 버려둔 설계 실수였다. 이제
// 처음 관측한 표본이 이미 선 위여도 그 시각을 breakoutTs로 잡아 elapsedMs가 계속 자라나게 한다 -
// 실제 돌파 시각보다 짧게(과소평가) 나올 수는 있어도 "확인불가"에 영원히 갇히지 않는다.
export interface VwapReclaimSignal {
  symbol: string;
  signal: boolean; // 확정(후행): reclaimed && volSurge - 참고용 레거시 필드
  reclaimed: boolean; // 즉시(가격만): 직전 표본 VWAP 아래 → 최신 표본 VWAP 위(오늘 한 번이라도 아래였음)
  elapsedMs: number | null; // reclaimed일 때만 값이 있음 - 관측된(또는 관측 시작 시점을 하한으로 삼은)
  // 돌파 이후 흐른 시간(ms). 화면은 이 값으로 "방금 확인(<30초)/유지 중(30초~5분)/오래된 완료(5분+)"
  // 3단계 신선도를 매긴다(사용자 확정: "이런 신호의 신선도를 넣어").
  volSurge: boolean; // 최근 60초(또는 돌파 이후 전체, 더 짧은 쪽) 거래량 속도가 돌파 전 60초 평균
  // 속도보다 높음 - 매 폴링마다 롤링 재계산되므로 한 번 확인되면 고정되는 값이 아니다.
  approaching: boolean; // 선행(액션 가능): 아직 미돌파 + 간격이 좁혀짐 + 임박(1.5% 이내) + 거래량 선행 증가
  // + 그 증가분이 매수 우위(틱 테스트 근사, 사용자 확정: "거래량 증가=활동성, 매수 우위=방향성 둘 다 보게")
  sellPressureWarning: boolean; // 🎯 [기능 추가 - 사용자 요청: "매도 우위인데 거래량만 급증한 종목은 임박
  // 상태를 아예 띄우지 않는거 어때? 지금 찾는게 '거래량 많은 종목'이 아니라 '재돌파할 가능성이 높은
  // 종목'이니까"] 간격 좁혀짐+임박 폭+거래량 증가까지는 approaching 조건을 다 만족했지만, 그 거래량
  // 증가분이 매도 우위라서 approaching에서 제외된 경우 - "재돌파 임박" 대신 "매도 압박"으로 별도 표시한다.
  hadPriorReclaim: boolean; // 오늘 이미 2번 이상 below→above 전환이 있었음 - "한 번 뚫었다가 다시 뚫으려는 재시도"
  crossCount: number; // 오늘 below→above 전환 누적 횟수(원본 숫자) - 4회 이상이면서 아직 신선(elapsedMs
  // 5분 미만)하면 "잦은 등락"(VWAP 근처 노이즈성 등락)으로 분류한다(사용자 확인: 실측 90 백분위수=4).
  // 🚨 [버그 수정 - 사용자 지적: "대우건설이 무슨 잦은등락이야, 지금 계속 고가 뚫고 가는구만"] 예전엔
  // 이 판정이 장중 누적치라 아침에 잠깐 흔들렸던 종목이 그 뒤 몇 시간을 안정적으로 버텨도 영원히
  // "잦은 등락"으로 남았다 - 5분 이상 신선하게 유지 중이면 최근 행동이 안정적이라는 뜻이므로 더 이상
  // 노이즈로 취급하지 않는다.
  insufficientData: boolean; // 표본이 2개 미만이라 판정 불가(장 시작 직후 등)
}

// 🎯 [기능 추가 - 사용자 요청: "R2까지 안가고 R1까지 뚫었어도 괜찮아... 손절선에 가도 괜찮아... 다시
// 올라올거 같은 반등"] 전일 확정 일봉 기준 고정 피봇 저항선(R1·R2)을 뚫었다가(깊이 상관없이) 다시 그
// 선을 향해 올라오는 종목을 잡는다 - VWAP 재돌파와 판정 로직은 동일(간격 좁혀짐+거래량 선행)하지만
// 기준선이 계속 움직이는 VWAP 대신 하루 종일 고정인 R1/R2라는 점이 다르다.
export interface PivotLevelSignal {
  reclaimed: boolean; // 재돌파(가격만, 즉시): 뚫은 적 있고(hasBroken) + 그 뒤 한 번이라도 밑으로 갔었고
  // (hasBeenBelowAfterBreak) + 지금 다시 위 - "눌렸다가 다시 뚫음"이 확인된 더 강한 신호
  // 🚨 [버그 수정 - 사용자 지적: "성호전자 왜 r2 뚫엇는데 r1완료라고만 뜸?"] holding: 처음 뚫은 뒤 한
  // 번도 안 내려가고 계속 위인 경우(재돌파 이력은 없지만 hasBroken=true) - 예전엔 이 경우 reclaimed도
  // hadPriorBreak도 둘 다 false라 화면이 이 레벨을 아예 못 본 것처럼 취급해 더 낮은 레벨을 대신
  // 보여줬다. reclaimed와 holding은 상호 배타적이다(동시에 true일 수 없음).
  holding: boolean;
  elapsedMs: number | null; // (reclaimed || holding)일 때만 값이 있는 신선도(ms)
  approaching: boolean; // 위 조건 + 지금은 밑인데 간격 좁혀짐 + 1.5% 이내 임박 + 거래량 선행 증가 + 매수 우위
  sellPressureWarning: boolean; // VWAP과 동일(수칙 1-6) - 거래량은 늘었지만 매도 우위라 임박에서 제외됨
  volSurge: boolean; // 최근 60초(또는 돌파 이후 전체) 거래량 속도가 돌파 전 60초 평균보다 높음(롤링 재계산)
  hadPriorBreak: boolean; // 오늘 이 선을 뚫었다가 다시 밑으로 내려간 적 있음 - reclaimed/approaching이 둘 다
  // false여도 이 값이 true면 "이전 이력만 있음"(대기 중, VWAP의 hadPriorReclaim과 동일한 목적)
  // 🎯 [기능 추가 - 사용자 지적: "돌파재시도 왜 몇번했는지 안알려줘?"] VWAP의 crossCount(감시 시작 후
  // below→above 전환 누적 횟수)와 동일한 개념(수칙 1-6) - 오늘 이 선을 몇 번째 (재)돌파 시도 중인지.
  crossCount: number;
}

// 🚨 [재설계 - 사용자 지적: "저렇게 박스를 하는게 내가 3분봉 보고 매매에 대해 도움이 되나? 나는 내
// 매매에 도움이 되는 박스를 형성에서 거기에 맞게 뱃지를먹여서 박스권 하락, 박스권 돌파 이런걸
// 원했던건데... 순위표 배지로"] 예전엔 이 값들이 PivotLevelSignal(R1/R2 레벨마다 따로) 안에
// boxRangePct/inBox/boxHighPrice/boxLowPrice/boxStartTs로 흩어져 있었다 - R1/R2 돌파 여부와 무관하게
// 종목 하나에 대해 "지금 박스/상승/하락 중 무엇인지" 딱 하나의 상태만 있으면 되므로, PivotReclaimSignal
// 최상위로 옮기고 이름도 목적에 맞게 바꿨다(kisApi.ts의 detectPriceLegsFromSamples가 채움).
export type PriceLegType = 'box' | 'up' | 'down';
export interface PriceLegSignal {
  type: PriceLegType; // 'box'=박스권 유지, 'up'=박스권재돌파(상승 추세), 'down'=R2돌파 후 하락(하락 추세)
  high: number;
  low: number;
  changePct: number; // box: (고가-저가)/중간가 %, up/down: 구간 시작가 대비 현재가 변동률(부호 있음)
  startTs: number; // 이 구간이 시작된 시각(epoch ms)
  durationMs: number; // 시작부터 지금까지 지속 시간
}

export interface PivotReclaimSignal {
  symbol: string;
  r1: PivotLevelSignal;
  r2: PivotLevelSignal; // r2가 걸려있으면 r1은 이미 걸려있는 게 자연스러움(R2가 R1보다 위)
  insufficientData: boolean;
  priceLeg: PriceLegSignal | null; // R1/R2와 무관한, 순수 가격 흐름 기반 현재 박스/추세 상태
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
export type RankingType = 'foreign' | 'organ' | 'program' | 'overlap' | 'surging' | 'comprehensive' | 'postmarket' | 'watchlist' | 'discovery' | 'precursor';
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

  // ============================================================================
  // 🎯 [기능 추가 - 사용자 요청: "발굴 장마감" 탭] "급등 장마감"(postmarket)이 등락률·거래량·거래대금
  // 상위 종목군에서만 후보를 고르다 보니 다음날 결과가 신통치 않았다("급등주에서 고르려니까 다음날
  // 결과가 그다지 좋지않은거같아") - 이 탭은 그 랭킹 풀에 의존하지 않고 KIS 여러 순위 API(등락률순위
  // 정렬 4종 + 거래량/거래대금순위 정렬 4종, 시장별)를 합쳐 훨씬 넓은 후보군에서 "물량을 누가 받았는지·
  // 오후까지 매수세가 유지됐는지·평소 대비 거래가 얼마나 몰렸는지·눌림에도 버텼는지·시장 대비 강한지"를
  // 본다. 오후 2시 30분경(장마감 전) 배치로 한 번 계산해 화면에서는 이 값만 그대로 보여준다.
  // ============================================================================
  absorptionBadge?: string;      // 상승 과정에서 누가 물량을 받았는지 (예: "외국인 순매수 우위")
  absorptionDirection?: 'foreign' | 'organ' | 'both' | 'none'; // 매집 주체 방향
  foreignAbsorptionQty?: number;  // 외국인 장중 추정 순매수 수량(주) - 부호가 매수/매도 방향
  organAbsorptionQty?: number;    // 기관 장중 추정 순매수 수량(주)
  afternoonVolumeRatioPct?: number; // 오늘 누적 거래대금 중 14시 이후 비중 (%) - 높을수록 매수세 유지
  volumeSurgeRatio?: number;     // 오늘 거래대금 ÷ 최근 20거래일 평균 거래대금 (배)
  rawVolumeSurgeRatio?: number;  // 오늘 거래량(주) ÷ 최근 20거래일 평균 거래량 (배)
  higherLowPattern?: boolean;    // 최근 5거래일 최저가가 그 이전 5거래일 최저가보다 높은지(저점 상승 패턴)
  pullbackFromHighPct?: number;  // 당일 고가 등락률 - 현재 등락률 (%p) - 0에 가까울수록 고가권 유지
  closeToHighRatioPct?: number;  // 현재가 ÷ 당일 고가 * 100 (%) - "종가가 고가의 90% 이상" 채점용
  relativeStrengthPct?: number;  // 현재 등락률 - 소속 시장(KOSPI/KOSDAQ) 지수 등락률 (%p)
  // 🎯 [기능 추가 - 사용자 요청: "발굴인데 너무 급등한 애들이 1등을 해서... 미급등성+재활성화"] 최근
  // 10거래일(오늘 제외) 평균 거래량이 그 이전 10거래일보다 더 조용했던 종목에 한해서만 채워진다(그렇지
  // 않으면 "한동안 잠잠하다 깨어남"이라 부를 수 없으므로 undefined) - 오늘 거래량이 그 "조용했던 최근
  // 10일" 평균 대비 몇 배인지.
  reactivationRatio?: number;
  discoveryScore?: number;       // 사용자가 확정한 배점(합계 100점) 절대 점수 - 백분위 상대평가 아님

  // ============================================================================
  // 🚨 [전면 재정의 - "눌림후속", 사용자 지적: "전조를 눌림후속으로 재정의하자"] 기존 4개 지표 점수식
  // (거래대금급증·증가추세·다이버전스·고가유지, precursorScore)과 배지(조용한매집/상방형)는 202거래일
  // 실측(scratch/backtest_C_*.js 일련, 2026-09-23)에서 점수-다음날수익률 상관계수가 사실상 0으로
  // 확인돼 전부 제거했다. 대신 "당일 하락(<-0.5%) + 종가/당일고가 94~97%"라는 2개 조건만으로 판정한다
  // (점수 없음 - 조건 충족 여부만). closeToHighRatioPct는 위 388행 필드를 그대로 재사용한다(수칙 1-6).
  //
  // 🎯 [실험 추가 - 사용자 지시: "가집계 vs 확정치 재현율 검증", 2026-09-23] 전체 유니버스 눌림후속
  // 백테스트(scratch/backtest_precursor_*.js 일련)에서 "당일 외국인 순매수비율 상위20%"가 209거래일
  // 워크포워드 전부(9/9 세분화 폴드)에서 일관되게 재현되는 유일한 요인이었다. 다만 백테스트는 18:00+
  // 확정치(FHKST01010900)로 했는데, 라이브 14:40 크론 시점엔 확정치가 아직 없고 14:30 가집계 추정치
  // (HHPTJ04160200)만 있다 - 이 둘이 실제로 얼마나 일치하는지 검증되지 않았다. 1단계로 14:40 크론에
  // 가집계 f13을 같이 저장하고, 2단계로 18:30 이후 확정 f13을 붙여 자동으로 적중률을 계산한다.
  foreignRatioEstimate?: number;      // 가집계(14:30 최종) 외국인 순매수수량/당일거래량*100 (%)
  foreignRatioEstimateTop20?: boolean; // 그날 눌림후속 후보군 내 foreignRatioEstimate 상위20% 여부
  foreignRatioEstimateRankPct?: number; // 그날 후보군 내 순위를 백분위로 환산(1위→0에 가까움, 낮을수록 상위)
  foreignRatioConfirmed?: number;      // 확정치(18:00+) 외국인 순매수수량/당일거래량*100 (%) - 당일 미확정이면 undefined
  foreignRatioConfirmedTop20?: boolean; // 그날 후보군 내 foreignRatioConfirmed 상위20% 여부
  // ============================================================================
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
  // program 탭 전용: 장중/애프터마켓인데 오라클 상시 수집기 데이터가 10분 넘게 갱신되지 않았음(수집기 멈춤/지연)
  collectorStale?: boolean;
}

export interface KisTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  access_token_token_expired?: string;
}

/**
 * 이름 키워드 기반 ETF/ETN 추정 - 종목 마스터에 없는 코드(ETN 'Q...' 코드 등)용 폴백 전용.
 * 🚨 종목코드를 알면 이 함수 대신 stockDictionary.ts의 isEtfSymbol(symbol, name)을 쓸 것 - 이 키워드 목록은
 * 운용사 브랜드(KIWOOM, 1Q, KoAct, TIME, WON, 파워, 마이티 등)가 빠져 ETF 208개를 주식으로 오분류했고,
 * 반대로 주식인 YG PLUS(037270)를 'PLUS' 때문에 ETF로 오판했다(2026-09-23 실측).
 */
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
