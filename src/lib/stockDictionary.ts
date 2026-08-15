import { StockInfo } from './types';
import masterStockData from './data/stockMasterCache.json';

export interface MasterStockEntry {
  symbol: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  stdCode?: string;
}

const masterList: MasterStockEntry[] = Array.isArray(masterStockData) ? (masterStockData as MasterStockEntry[]) : [];

export function getMasterStockList(): MasterStockEntry[] {
  return masterList;
}

/**
 * 전역 마스터 종목 한글명 매핑 사전
 * 시세 계산/Mock 데이터 수정 시에도 훼손되지 않도록 독립 관리
 */
export const STOCK_NAME_MAP: Record<string, string> = {
  // 대표 대형주 (KOSPI 200 & KOSDAQ 150)
  '005930': '삼성전자',
  '005935': '삼성전자우',
  '000660': 'SK하이닉스',
  '373220': 'LG에너지솔루션',
  '207940': '삼성바이오로직스',
  '005380': '현대차',
  '000270': '기아',
  '068270': '셀트리온',
  '105560': 'KB금융',
  '055550': '신한지주',
  '035420': 'NAVER',
  '035720': '카카오',
  '005490': 'POSCO홀딩스',
  '028260': '삼성물산',
  '012330': '현대모비스',
  '051910': 'LG화학',
  '006400': '삼성SDI',
  '329180': 'HD현대중공업',
  '138040': '메리츠금융지주',
  '196170': '알테오젠',
  '247540': '에코프로비엠',
  '086520': '에코프로',
  '000810': '삼성화재',
  '000815': '삼성화재우',
  '015760': '한국전력',
  '032830': '삼성생명',
  '017670': 'SK텔레콤',
  '010140': '삼성중공업',
  '009150': '삼성전기',
  '030200': 'KT',
  '036570': '엔씨소프트',
  '259960': '크래프톤',
  '018260': '삼성SDS',
  '003550': 'LG',
  '034730': 'SK',
  '011200': 'HMM',
  '010950': 'S-Oil',
  '034220': 'LG디스플레이',
  '010130': '고려아연',
  '003670': '포스코퓨처엠',
  '271560': '오리온',
  '090430': '아모레퍼시픽',
  '000100': '유한양행',
  '263750': '펄어비스',
  '041510': 'SM',
  '352820': '하이브',
  '004020': '현대제철',
  '028050': '삼성엔지니어링',
  '000720': '현대건설',
  '005830': 'DB손해보험',
  '071050': '한국금융지주',
  '009540': 'HD한국조선해양',
  '047810': '한국항공우주',
  '021240': '코웨이',
  '000150': '두산에너빌리티',
  '024110': '기업은행',
  '086790': '하나금융지주',
  '033780': 'KT&G',
  '032640': 'LG유플러스',
  '001040': 'CJ',
  '000120': 'CJ대한통운',
  '078930': 'GS',
  '012450': '한화에어로스페이스',
  '009830': '한화솔루션',
  '042660': '한화오션',
  '001450': '현대해상',
  '004990': '롯데지주',
  '023530': '롯데쇼핑',
  '011170': '롯데케미칼',
  '006360': 'GS건설',
  '403070': 'HPSP',
  '293490': '카카오게임즈',
  '251270': '넷마블',
  '293500': 'HLB',
  '003490': '대한항공',
  '402340': 'SK스퀘어',
  '332570': 'PS일렉트로닉스',
  '454910': '두산로보틱스',
  '277810': '레인보우로보틱스',
  '058470': '리노공업',
  '086900': '메디톡스',
  '214150': '클래시스',
  '001800': '오리온홀딩스',
  '000105': '유한양행우',
  '003230': '삼양식품',
  '001680': '대상',
  '004370': '농심',
  '005300': '롯데칠성',
  '007310': '오뚜기',
  '017800': '현대백화점',
  '008770': '호텔신라',
  '069960': '현대백화점',
  '004170': '신세계',
  '026960': '동서',
  '001530': 'DI동일',
  '005940': 'NH투자증권',
  '016360': '삼성증권',
  '039490': '키움증권',
  '003470': '유진투자증권',
  '001500': '현대차증권',
  '003540': '대신증권',
  '005945': 'NH투자증권우',
  '008930': '한미반도체',
  '042700': '한미반도체',
  '128940': '한미약품',
  '185750': '종근당',
  '006280': '녹십자',
  '000210': 'DL',
  '039130': '하나투어',
  '080440': '모두투어',
  '030000': '제일기획',
  '032650': 'SK오션플랜트',
  '009410': '태영건설',
  '006380': '카프로',
  '011070': 'LG이노텍',
  '035250': '강원랜드',
  '034020': '두산에너빌리티',
  '000157': '두산2우B',
  '011780': '금호석유',
  '002790': '아모레G',
  '003240': '태광산업',
  '010060': 'OCI홀딩스',
  '011790': 'SKC',
  '006800': '미래에셋증권',
  '003690': '코리안리',
  '000670': '영풍',
  '001740': 'SK네트웍스',
  '002380': 'KCC',
  '020150': '일진머티리얼즈',
  '001430': '세아베스틸지주',
  '001230': '동국제강',
  '005880': '대한해운',
  '003410': '쌍용C&E',
  '004000': '롯데정밀화학',
  '014680': '한솔케미칼',
  '036460': '한국가스공사',
  '005070': '코스모신소재',
  '005420': '코스모화학',
};

/**
 * KIS API 응답 및 실시간 수급 조회 시 자동 갱신되는 동적 종목명 캐시
 */
const runtimeStockNameCache = new Map<string, string>();

/**
 * 실시간 API 및 랭킹 조회 시 종목 정보 동적 등록
 */
export function registerRuntimeStockName(symbol: string, name: string): void {
  if (symbol && name && name.trim() !== '' && !name.startsWith('종목 ') && name !== symbol) {
    runtimeStockNameCache.set(symbol, name.trim());
  }
}

/**
 * 종목 코드를 한글 종목명으로 변환해주는 마스터 조회 함수
 * 1. rawName
 * 2. runtimeStockNameCache
 * 3. STOCK_NAME_MAP
 * 4. KIS Master Stock Dataset (3,554개 전체 상장 종목)
 */
export function getStockName(symbol: string, rawName?: string): string {
  if (rawName && rawName.trim() !== '' && !rawName.startsWith('종목 ') && rawName !== symbol) {
    const cleanName = rawName.trim();
    runtimeStockNameCache.set(symbol, cleanName);
    return cleanName;
  }

  if (runtimeStockNameCache.has(symbol)) {
    return runtimeStockNameCache.get(symbol)!;
  }

  if (STOCK_NAME_MAP[symbol]) {
    return STOCK_NAME_MAP[symbol];
  }

  const masterList = getMasterStockList();
  const foundMaster = masterList.find((m) => m.symbol === symbol);
  if (foundMaster) {
    return foundMaster.name;
  }

  return symbol;
}

/**
 * 동적 캐시 전체 포함 여부 확인 및 내보내기 함수
 */
export function getRuntimeStockNameCache(): Map<string, string> {
  return runtimeStockNameCache;
}

/**
 * 검색 대상 전체 종목 리스트 생성
 * (KIS Master 전체 상장 3,554개 종목 + STOCK_NAME_MAP + runtimeStockNameCache + PRESET/TOP50)
 */
export function buildSearchStockList(
  presets: StockInfo[] = [],
  top50s: { symbol: string; name: string; market: string; basePrice: number }[] = []
): StockInfo[] {
  const map = new Map<string, StockInfo>();

  // 1. KIS Master Dataset (3,554개 전체 상장 종목)
  const masterList = getMasterStockList();
  masterList.forEach((m) => {
    map.set(m.symbol, {
      symbol: m.symbol,
      name: m.name,
      market: m.market,
      currentPrice: 50000,
      change: 0,
      changeRate: 0,
      volume: 1000000,
    });
  });

  // 2. Static preset stocks overlay
  presets.forEach((s) => map.set(s.symbol, s));

  // 3. Static TOP 50 stocks overlay
  top50s.forEach((s) => {
    const existing = map.get(s.symbol);
    map.set(s.symbol, {
      symbol: s.symbol,
      name: s.name,
      market: (s.market as 'KOSPI' | 'KOSDAQ') || existing?.market || 'KOSPI',
      currentPrice: s.basePrice,
      change: 0,
      changeRate: 0,
      volume: 1000000,
    });
  });

  // 4. STOCK_NAME_MAP master entries overlay
  Object.entries(STOCK_NAME_MAP).forEach(([sym, name]) => {
    if (map.has(sym)) {
      const existing = map.get(sym)!;
      map.set(sym, { ...existing, name });
    } else {
      map.set(sym, {
        symbol: sym,
        name,
        market: 'KOSPI',
        currentPrice: 50000,
        change: 0,
        changeRate: 0,
        volume: 1000000,
      });
    }
  });

  // 5. Runtime dynamically cached stocks
  runtimeStockNameCache.forEach((name, sym) => {
    if (map.has(sym)) {
      const existing = map.get(sym)!;
      map.set(sym, { ...existing, name });
    } else {
      map.set(sym, {
        symbol: sym,
        name,
        market: 'KOSPI',
        currentPrice: 50000,
        change: 0,
        changeRate: 0,
        volume: 1000000,
      });
    }
  });

  return Array.from(map.values());
}

/**
 * 입력 문자열(한글 종목명 또는 6자리 코드)을 6자리 종목 코드로 단일 해석해주는 헬퍼
 */
export function resolveSymbolOrName(input: string, searchList: StockInfo[]): string {
  const query = input.trim();
  if (!query) return '005930';

  // 1. 6자리 영문/숫자 코드 직접 입력된 경우
  if (/^\d{6}$/.test(query)) {
    return query;
  }

  const queryLower = query.toLowerCase();

  // 2. 정확한 이름 매칭 (예: "대원전선" -> "006340")
  const exactMatch = searchList.find((s) => s.name === query || s.name.toLowerCase() === queryLower);
  if (exactMatch) return exactMatch.symbol;

  // 3. 이름이 query로 시작하는 매칭
  const prefixMatch = searchList.find((s) => s.name.toLowerCase().startsWith(queryLower));
  if (prefixMatch) return prefixMatch.symbol;

  // 4. 부분 이름 매칭 (예: "대원전선" 포함)
  const partialMatch = searchList.find((s) => s.name.toLowerCase().includes(queryLower));
  if (partialMatch) return partialMatch.symbol;

  // 5. 부분 코드 매칭
  const codeMatch = searchList.find((s) => s.symbol.includes(query));
  if (codeMatch) return codeMatch.symbol;

  return query;
}

