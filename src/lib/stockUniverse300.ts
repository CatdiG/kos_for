export interface StockCatalogItem {
  symbol: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  basePrice: number;
}

// 코스피 200 + 코스닥 100 대표 시가총액 상위 300종목 풀 (SK스퀘어 402340 포함)
export const TOP_300_STOCKS: StockCatalogItem[] = [
  {
    "symbol": "005930",
    "name": "삼성전자",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000660",
    "name": "SK하이닉스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005935",
    "name": "삼성전자우",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "402340",
    "name": "SK스퀘어",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "009150",
    "name": "삼성전기",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "373220",
    "name": "LG에너지솔루션",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005380",
    "name": "현대차",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "207940",
    "name": "삼성바이오로직스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "032830",
    "name": "삼성생명",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "105560",
    "name": "KB금융",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "028260",
    "name": "삼성물산",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "012450",
    "name": "한화에어로스페이스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "034020",
    "name": "두산에너빌리티",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "055550",
    "name": "신한지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000270",
    "name": "기아",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "329180",
    "name": "HD현대중공업",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "006400",
    "name": "삼성SDI",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "068270",
    "name": "셀트리온",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "012330",
    "name": "현대모비스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "034730",
    "name": "SK",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "086790",
    "name": "하나금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "035420",
    "name": "NAVER",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "066570",
    "name": "LG전자",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "010120",
    "name": "LS ELECTRIC",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000810",
    "name": "삼성화재",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "298040",
    "name": "효성중공업",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "267260",
    "name": "HD현대일렉트릭",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "010130",
    "name": "고려아연",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "042660",
    "name": "한화오션",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005490",
    "name": "POSCO홀딩스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "009540",
    "name": "HD한국조선해양",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "069500",
    "name": "KODEX 200",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "316140",
    "name": "우리금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "017670",
    "name": "SK텔레콤",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "042700",
    "name": "한미반도체",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "015760",
    "name": "한국전력",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "011200",
    "name": "HMM",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "360750",
    "name": "TIGER 미국S&P500",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "138040",
    "name": "메리츠금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000150",
    "name": "두산",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "096770",
    "name": "SK이노베이션",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "006800",
    "name": "미래에셋증권",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "051910",
    "name": "LG화학",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "018260",
    "name": "삼성에스디에스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "010140",
    "name": "삼성중공업",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "033780",
    "name": "KT&G",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "003550",
    "name": "LG",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "278470",
    "name": "에이피알",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "267250",
    "name": "HD현대",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "010950",
    "name": "S-Oil",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "024110",
    "name": "기업은행",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "003670",
    "name": "포스코퓨처엠",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "035720",
    "name": "카카오",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "079550",
    "name": "LIG디펜스앤에어로스페이스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "086280",
    "name": "현대글로비스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "064350",
    "name": "현대로템",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "011070",
    "name": "LG이노텍",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000720",
    "name": "현대건설",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "272210",
    "name": "한화시스템",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "030200",
    "name": "KT",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "047810",
    "name": "한국항공우주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005830",
    "name": "DB손해보험",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "078930",
    "name": "GS",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "003230",
    "name": "삼양식품",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "133690",
    "name": "TIGER 미국나스닥100",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "307950",
    "name": "현대오토에버",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "071050",
    "name": "한국금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "003490",
    "name": "대한항공",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "323410",
    "name": "카카오뱅크",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "102110",
    "name": "TIGER 200",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "259960",
    "name": "크래프톤",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "379800",
    "name": "KODEX 미국S&P500",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "443060",
    "name": "HD현대마린솔루션",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005940",
    "name": "NH투자증권",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "006260",
    "name": "LS",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "028050",
    "name": "삼성E&A",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "396500",
    "name": "TIGER 반도체TOP10",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "379810",
    "name": "KODEX 미국나스닥100",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "047050",
    "name": "포스코인터내셔널",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "090430",
    "name": "아모레퍼시픽",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "180640",
    "name": "한진칼",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "488770",
    "name": "KODEX 머니마켓액티브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "007660",
    "name": "이수페타시스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "161390",
    "name": "한국타이어앤테크놀로지",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "047040",
    "name": "대우건설",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "016360",
    "name": "삼성증권",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "352820",
    "name": "하이브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "278530",
    "name": "KODEX 200TR",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "009830",
    "name": "한화솔루션",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "064400",
    "name": "LG씨엔에스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "039490",
    "name": "키움증권",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000880",
    "name": "한화",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "021240",
    "name": "코웨이",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "326030",
    "name": "SK바이오팜",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005387",
    "name": "현대차2우B",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "267270",
    "name": "HD건설기계",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "128940",
    "name": "한미약품",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "459580",
    "name": "KODEX CD금리액티브(합성)",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "377300",
    "name": "카카오페이",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "032640",
    "name": "LG유플러스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000100",
    "name": "유한양행",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "062040",
    "name": "산일전기",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000500",
    "name": "가온전선",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "241560",
    "name": "두산밥캣",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "122630",
    "name": "KODEX 레버리지",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "001440",
    "name": "대한전선",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "498400",
    "name": "KODEX 200타겟위클리커버드콜",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "381180",
    "name": "TIGER 미국필라델피아반도체나스닥",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "091160",
    "name": "KODEX 반도체",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "066970",
    "name": "엘앤에프",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "029780",
    "name": "삼성카드",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "175330",
    "name": "JB금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "353200",
    "name": "대덕전자",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "088350",
    "name": "한화생명",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "010060",
    "name": "OCI홀딩스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "271560",
    "name": "오리온",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "229200",
    "name": "KODEX 코스닥150",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "036570",
    "name": "NC",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "034220",
    "name": "LG디스플레이",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "088980",
    "name": "맥쿼리인프라",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "051900",
    "name": "LG생활건강",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "138930",
    "name": "BNK금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "052690",
    "name": "한전기술",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "454910",
    "name": "두산로보틱스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "011790",
    "name": "SKC",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005385",
    "name": "현대차우",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "001450",
    "name": "현대해상",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "148020",
    "name": "RISE 200",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "310970",
    "name": "TIGER MSCI Korea TR",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "458730",
    "name": "TIGER 미국배당다우존스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "411060",
    "name": "ACE KRX금현물",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "004020",
    "name": "현대제철",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "000990",
    "name": "DB하이텍",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "002380",
    "name": "KCC",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "082740",
    "name": "한화엔진",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "395160",
    "name": "KODEX AI반도체TOP2플러스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "360200",
    "name": "ACE 미국S&P500",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "004170",
    "name": "신세계",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "161890",
    "name": "한국콜마",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "001040",
    "name": "CJ",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "381170",
    "name": "TIGER 미국테크TOP10 INDXX",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "233740",
    "name": "KODEX 코스닥150레버리지",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "018880",
    "name": "한온시스템",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "423160",
    "name": "KODEX KOFR금리액티브(합성)",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "357870",
    "name": "TIGER CD금리투자KIS(합성)",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "395270",
    "name": "HANARO Fn K-반도체",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "103590",
    "name": "일진전기",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "367380",
    "name": "ACE 미국나스닥100",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "102780",
    "name": "KODEX 삼성그룹",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "192820",
    "name": "코스맥스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "036460",
    "name": "한국가스공사",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "009420",
    "name": "한올바이오파마",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "273130",
    "name": "KODEX 종합채권(AA-이상)액티브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "487240",
    "name": "KODEX AI전력핵심설비",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "111770",
    "name": "영원무역",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "022100",
    "name": "포스코DX",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "006360",
    "name": "GS건설",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "012750",
    "name": "에스원",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "011780",
    "name": "금호석유화학",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "035250",
    "name": "강원랜드",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "085620",
    "name": "미래에셋생명",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "455890",
    "name": "RISE 머니마켓액티브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "251270",
    "name": "넷마블",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "031210",
    "name": "서울보증보험",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "028670",
    "name": "팬오션",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "302440",
    "name": "SK바이오사이언스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "008930",
    "name": "한미사이언스",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "336260",
    "name": "두산퓨얼셀",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "017800",
    "name": "현대엘리베이터",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "023530",
    "name": "롯데쇼핑",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "004800",
    "name": "효성",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "139130",
    "name": "iM금융지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "483650",
    "name": "달바글로벌",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "097950",
    "name": "CJ제일제당",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "375500",
    "name": "DL이앤씨",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "007340",
    "name": "DN오토모티브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "004370",
    "name": "농심",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "450080",
    "name": "에코프로머티",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "139260",
    "name": "TIGER 200 IT",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "472150",
    "name": "TIGER 배당커버드콜액티브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "026960",
    "name": "동서",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "003690",
    "name": "코리안리",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "383220",
    "name": "F&F",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "001720",
    "name": "신영증권",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "011170",
    "name": "롯데케미칼",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "282330",
    "name": "BGF리테일",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "489790",
    "name": "한화비전",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "481050",
    "name": "KODEX CD1년금리플러스액티브(합성)",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "161510",
    "name": "PLUS 고배당주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "486290",
    "name": "TIGER 미국나스닥100타겟데일리커버드콜",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "426030",
    "name": "TIME 미국나스닥100액티브",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "005850",
    "name": "에스엘",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "103140",
    "name": "풍산",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "004990",
    "name": "롯데지주",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "449170",
    "name": "TIGER KOFR금리액티브(합성)",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "204320",
    "name": "HL만도",
    "market": "KOSPI",
    "basePrice": 50000
  },
  {
    "symbol": "196170",
    "name": "알테오젠",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "086520",
    "name": "에코프로",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "247540",
    "name": "에코프로비엠",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "277810",
    "name": "레인보우로보틱스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "036930",
    "name": "주성엔지니어링",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "240810",
    "name": "원익IPS",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "058470",
    "name": "리노공업",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "039030",
    "name": "이오테크닉스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "028300",
    "name": "HLB",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "214450",
    "name": "파마리서치",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "222800",
    "name": "심텍",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "087010",
    "name": "펩트론",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "298380",
    "name": "에이비엘바이오",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "403870",
    "name": "HPSP",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "000250",
    "name": "삼천당제약",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "141080",
    "name": "리가켐바이오",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "319660",
    "name": "피에스케이",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "095340",
    "name": "ISC",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "108490",
    "name": "로보티즈",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "257720",
    "name": "실리콘투",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "145020",
    "name": "휴젤",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "310210",
    "name": "보로노이",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "440110",
    "name": "파두",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "084370",
    "name": "유진테크",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "214370",
    "name": "케어젠",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "095610",
    "name": "테스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "357780",
    "name": "솔브레인",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "064760",
    "name": "티씨케이",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "319400",
    "name": "현대무벡스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "080220",
    "name": "제주반도체",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "131290",
    "name": "티에스이",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "031980",
    "name": "피에스케이홀딩스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "347850",
    "name": "디앤디파마텍",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "178320",
    "name": "서진시스템",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "067310",
    "name": "하나마이크론",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "237690",
    "name": "에스티팜",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "226950",
    "name": "올릭스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "010170",
    "name": "대한광통신",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "214150",
    "name": "클래시스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "032820",
    "name": "우리기술",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "005290",
    "name": "동진쎄미켐",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "140410",
    "name": "메지온",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "058610",
    "name": "에스피지",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "263750",
    "name": "펄어비스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "083650",
    "name": "비에이치아이",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "098460",
    "name": "고영",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "140860",
    "name": "파크시스템스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "068760",
    "name": "셀트리온제약",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "096530",
    "name": "씨젠",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "089030",
    "name": "테크윙",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "060370",
    "name": "LS마린솔루션",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "041510",
    "name": "에스엠",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "241710",
    "name": "코스메카코리아",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "007390",
    "name": "네이처셀",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "950160",
    "name": "코오롱티슈진",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "131970",
    "name": "두산테스나",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "089970",
    "name": "브이엠",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "323280",
    "name": "태성",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "030530",
    "name": "원익홀딩스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "078600",
    "name": "대주전자재료",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "475830",
    "name": "오름테라퓨틱",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "290650",
    "name": "엘앤씨바이오",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "035900",
    "name": "JYP Ent.",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "420770",
    "name": "기가비스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "039200",
    "name": "오스코텍",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "183300",
    "name": "코미코",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "082920",
    "name": "비츠로셀",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "127120",
    "name": "제이에스링크",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "218410",
    "name": "RFHIC",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "003380",
    "name": "하림지주",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "195940",
    "name": "HK이노엔",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "204270",
    "name": "제이앤티씨",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "043260",
    "name": "성호전자",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "347700",
    "name": "스피어",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "166090",
    "name": "하나머티리얼즈",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "437730",
    "name": "삼현",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "086450",
    "name": "동국제약",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "356860",
    "name": "티엘비",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "232140",
    "name": "와이씨",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "445680",
    "name": "큐리옥스바이오시스템즈",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "036540",
    "name": "SFA반도체",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "124500",
    "name": "아이티센글로벌",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "036830",
    "name": "솔브레인홀딩스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "950260",
    "name": "인제니아테라퓨틱스(Reg.S)",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "293490",
    "name": "카카오게임즈",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "476830",
    "name": "알지노믹스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "101490",
    "name": "에스앤에스텍",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "056190",
    "name": "SFA",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "119850",
    "name": "지엔씨에너지",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "038500",
    "name": "삼표시멘트",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "100790",
    "name": "미래에셋벤처투자",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "458870",
    "name": "씨어스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "014620",
    "name": "성광벤드",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "491000",
    "name": "리브스메드",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "065350",
    "name": "신성델타테크",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "252990",
    "name": "샘씨엔에스",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "083450",
    "name": "GST",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "099320",
    "name": "쎄트렉아이",
    "market": "KOSDAQ",
    "basePrice": 30000
  },
  {
    "symbol": "031330",
    "name": "에스에이엠티",
    "market": "KOSDAQ",
    "basePrice": 30000
  }
];