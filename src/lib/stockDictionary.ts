import { StockInfo, isEtfOrEtn } from './types';
import masterStockData from './data/stockMasterCache.json';

export interface MasterStockEntry {
  symbol: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  stdCode?: string;
  // KIS 종목정보 파일의 증권그룹구분코드: ST 주권, EF ETF, RT 리츠, IF 인프라펀드, MF 뮤추얼펀드,
  // DR 예탁증서, FS 외국주권 (scripts/regenerate_stock_master_cache.js가 채움 - 사이트 헤더 배지로 갱신 필요 알림 → GitHub Actions 수동 실행으로 반영)
  group?: string;
}

const masterList: MasterStockEntry[] = Array.isArray(masterStockData) ? (masterStockData as MasterStockEntry[]) : [];
const masterBySymbol = new Map<string, MasterStockEntry>(masterList.map((m) => [m.symbol, m]));

export function getMasterStockList(): MasterStockEntry[] {
  return masterList;
}

/**
 * ETF/ETN 판별 - 종목코드가 마스터에 있으면 KIS 공식 그룹코드(EF)로 판별하고, 마스터에 없는 코드
 * (ETN 'Q...' 코드, 마스터 갱신 이후 신규 상장 등)만 이름 키워드(types.ts isEtfOrEtn)로 폴백한다.
 * 기존 이름 키워드 방식은 운용사 브랜드 누락으로 ETF 208개를 주식으로, 주식 YG PLUS를 ETF로 오분류했다.
 * 리츠(RT)·인프라펀드(IF)·예탁증서(DR) 등은 기존과 동일하게 "ETF 아님"으로 둔다(유니버스 범위 유지).
 */
export function isEtfSymbol(symbol: string | undefined, name: string): boolean {
  const entry = symbol ? masterBySymbol.get(symbol) : undefined;
  if (entry?.group) return entry.group === 'EF';
  return isEtfOrEtn(name);
}

/**
 * 종목코드로 마스터 항목 조회(O(1)). 종목명·시장 판별의 기준 데이터.
 * 🚨 [버그 수정 - 2026-09-23] 예전엔 하드코딩 사전 STOCK_NAME_MAP(138개)이 마스터보다 우선했는데, 마스터가
 * KIS 공식 종목정보 파일로 재생성(scripts/regenerate_stock_master_cache.js)되는 것과 달리 이 사전은 손으로 적은 뒤 방치돼
 * 옛 이름(엔씨소프트→NC, 삼성엔지니어링→삼성E&A 등 12건)이 최신 이름을 덮어썼고, 아예 다른 회사를 가리키는
 * 항목(017800을 "현대백화점"으로 - 실제 현대엘리베이터, 003470 "유진투자증권" - 실제 유안타증권, 008930
 * "한미반도체" - 실제 한미사이언스, 000150 "두산2우B" - 실제 두산)과 존재하지 않는 코드(293500 "HLB" 등 5건)가
 * 검색 목록에 그대로 섞였다. 138개 전부가 "마스터에 이미 있어 불필요"하거나 "틀려서 해로운" 항목이라 사전을
 * 삭제하고 마스터를 단일 기준으로 삼는다.
 */
export function getMasterEntry(symbol: string): MasterStockEntry | undefined {
  return masterBySymbol.get(symbol);
}

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
 * 1. rawName (KIS API가 방금 돌려준 이름)
 * 2. runtimeStockNameCache (KIS API 응답에서 수집된 이름)
 * 3. KIS 종목 마스터 (KIS 공식 종목정보 기준, 이름의 기준)
 * ※ mockData.ts getStockName도 같은 우선순위를 따른다(두 함수는 각자 런타임 캐시를 가져 완전 통합은 안 됨).
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

  const foundMaster = masterBySymbol.get(symbol);
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
 * (KIS 종목 마스터 전체 + runtimeStockNameCache + PRESET/TOP50)
 * 🚨 종목명·시장은 KIS 공식 종목정보로 만든 마스터가 기준이다. PRESET/TOP50은 손으로 적은 정적 목록이라
 * 마스터에 없는 종목을 "채우는" 용도로만 쓰고, 마스터 항목의 이름/시장을 덮어쓰지 않는다
 * (예전엔 덮어써서 옛 이름 "엔씨소프트"(현 NC), 이전상장 전 시장 "엘앤에프=KOSDAQ"(현 KOSPI)이 노출됐다).
 */
export function buildSearchStockList(
  presets: StockInfo[] = [],
  top50s: { symbol: string; name: string; market: string; basePrice: number }[] = []
): StockInfo[] {
  const map = new Map<string, StockInfo>();

  // 1. KIS 종목 마스터 (이름·시장의 기준)
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

  // 2. Static preset stocks - 마스터에 없는 종목만 채움
  presets.forEach((s) => {
    if (!map.has(s.symbol)) map.set(s.symbol, s);
  });

  // 3. Static TOP 50 stocks - 마스터에 없는 종목만 채움
  top50s.forEach((s) => {
    if (map.has(s.symbol)) return;
    map.set(s.symbol, {
      symbol: s.symbol,
      name: s.name,
      market: (s.market as 'KOSPI' | 'KOSDAQ') || 'KOSPI',
      currentPrice: s.basePrice,
      change: 0,
      changeRate: 0,
      volume: 1000000,
    });
  });

  // 4. Runtime dynamically cached stocks (KIS API 응답에서 수집된 최신 이름 - getStockName과 같은 우선순위)
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
 * KRX 종목 단축코드 규칙: 6자리, 첫 글자는 항상 숫자. 기존 숫자 코드(005930)와 최근 상장 종목에 쓰이는
 * 영숫자 신코드(0126Z0 삼성에피스홀딩스, 00088K 한화3우B 등)를 모두 포함한다. 영숫자 코드도 종목 화면이
 * 쓰는 KIS TR 8종이 전부 정상 응답함을 실측 확인했다(scratch/diagnose_alnum_symbol_kis_support.js).
 * 첫 글자를 숫자로 제한해서 "KBSTAR" 같은 6글자 영문 종목명 입력이 코드로 오인되지 않게 한다.
 */
export const KRX_SYMBOL_PATTERN = /^\d[0-9A-Z]{5}$/;

/**
 * 검색창 드롭다운 필터/정렬 공통 함수 - 데스크톱(StockSearch.tsx)·모바일(MobileStockSearch.tsx)·
 * /api/stock/search가 똑같은 로직을 각자 복사해 쓰던 것을 하나로 합쳤다(수칙 1-6). 종목명과 코드 모두
 * 대소문자 무시로 비교한다 - 영숫자 코드를 소문자로 입력해도(0126z0) 찾히게 하기 위함.
 */
export function filterSearchStockList(searchList: StockInfo[], rawQuery: string, limit: number): StockInfo[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const matches = searchList.filter(
    (s) => s.name.toLowerCase().includes(query) || s.symbol.toLowerCase().includes(query)
  );
  matches.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aExact = aName === query ? 0 : aName.startsWith(query) ? 1 : 2;
    const bExact = bName === query ? 0 : bName.startsWith(query) ? 1 : 2;
    return aExact - bExact;
  });
  return matches.slice(0, limit);
}

/**
 * 입력 문자열(한글 종목명 또는 6자리 코드)을 6자리 종목 코드로 단일 해석해주는 헬퍼.
 * 해석할 수 없으면 null을 돌려준다(호출부가 "검색 결과 없음"을 보여줌).
 * 🚨 [버그 수정 - 2026-09-23] 예전엔 끝까지 못 찾으면 입력 문자열을 그대로 종목코드로 돌려줘서(return query),
 * "코윈테크"처럼 목록에 없는 글자를 치고 Enter를 누르면 그 글자 자체로 KIS 조회를 날렸다. 빈 입력도
 * 삼성전자('005930')로 바꿔치기하던 기본값을 없앤다.
 * 단, 6자리 코드 형식이면 목록에 없어도 그대로 조회한다 - 종목 마스터는 헤더 배지 알림 후 수동 반영
 * (GitHub Actions)해야 바뀌므로, 반영 전 신규 상장주도 코드로는 바로 볼 수 있어야 하기 때문.
 */
export function resolveSymbolOrName(input: string, searchList: StockInfo[]): string | null {
  const query = input.trim();
  if (!query) return null;

  // 1. 6자리 종목코드(숫자 또는 영숫자 신코드)가 직접 입력된 경우 - KIS는 대문자 코드만 받으므로 대문자로 정규화
  if (KRX_SYMBOL_PATTERN.test(query.toUpperCase())) {
    return query.toUpperCase();
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
  const codeMatch = searchList.find((s) => s.symbol.toLowerCase().includes(queryLower));
  if (codeMatch) return codeMatch.symbol;

  return null;
}

