// KIS 공식 종목정보 파일(kospi_code.mst / kosdaq_code.mst) 다운로드·압축해제·파싱·비교 공통 모듈.
// 사용처(수칙 1-6 단일 구현):
//  - /api/stock/master-status : 배포된 사이트가 스스로 "종목 마스터 갱신 필요" 여부를 확인해 헤더 배지로 띄움
//  - scripts/regenerate_stock_master_cache.js : 실제 반영(src/lib/data/stockMasterCache.json 재생성).
//    GitHub Actions 수동 실행 워크플로(.github/workflows/stock-master-apply.yml)가 이 스크립트를 돌린다.
//
// 파일 형식: CP949 고정폭 레코드. 앞부분 = 단축코드(9바이트) + 표준코드(12바이트) + 한글명(가변),
// 뒷부분 = 코스피 227바이트 / 코스닥 221바이트(개행 제외) 고정폭 필드, 첫 2바이트가 증권그룹구분코드.
// 한글명이 가변 길이라 반드시 "바이트" 기준으로 뒤에서 잘라야 한다(문자 기준으로 자르면 경계가 밀림).
import zlib from 'zlib';
import { KRX_SYMBOL_PATTERN, type MasterStockEntry } from './stockDictionary';

export const KIS_MASTER_ZIP_URLS = {
  kospi: 'https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip',
  kosdaq: 'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip',
} as const;

// 포함할 증권그룹구분코드(고정): ST 주권, EF ETF, RT 리츠, IF 인프라펀드, MF 뮤추얼펀드, DR 예탁증서, FS 외국주권.
// "기존 마스터에 있던 그룹"으로 동적 계산하면 어느 날 한 그룹이 KIS 파일에서 일시적으로 빠졌을 때 다음 갱신부터
// 그 그룹이 영구히 사라질 수 있어 고정 목록으로 둔다. (ETN은 'Q...' 코드라 KRX_SYMBOL_PATTERN에서 원래 제외)
export const ALLOWED_GROUPS = new Set(['ST', 'EF', 'RT', 'IF', 'MF', 'DR', 'FS']);

// 안전장치: 새 목록이 기존보다 이 비율 이상 줄면 비정상으로 본다. 상장폐지는 하루 수 건 수준이라 정상 갱신에서
// 5%(약 200종목)가 한 번에 빠질 일은 없고, 이만큼 줄었다면 다운로드가 잘렸거나 파일 형식이 바뀐 것으로 본다.
export const MAX_SHRINK_RATIO = 0.05;

const KOSPI_TAIL_BYTES = 227;
const KOSDAQ_TAIL_BYTES = 221;

/** 단일 파일이 든 zip에서 첫 번째 파일 내용을 꺼낸다(중앙 디렉토리 기준 - 데이터 디스크립터 방식 zip도 처리). */
export function unzipFirstFile(zip: Buffer): Buffer {
  // End Of Central Directory 레코드(서명 0x06054b50)를 뒤에서부터 찾는다(주석 최대 65535바이트)
  const minEocd = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= minEocd; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 형식 오류: EOCD 없음');
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip 형식 오류: 중앙 디렉토리 서명 불일치');
  const method = zip.readUInt16LE(cdOffset + 10);
  const compSize = zip.readUInt32LE(cdOffset + 20);
  const localOffset = zip.readUInt32LE(cdOffset + 42);
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 형식 오류: 로컬 헤더 서명 불일치');
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip 압축 방식 미지원: ${method}`);
}

export interface KisMasterFiles {
  kospi: Buffer;
  kosdaq: Buffer;
  lastModified: string | null; // 서버 Last-Modified(코스피 파일 기준) - 화면에 "KIS 파일 기준 시각"으로 표시
}

export async function downloadKisMasterFiles(timeoutMs = 15000): Promise<KisMasterFiles> {
  const get = async (url: string) => {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`KIS 종목정보 파일 다운로드 실패 HTTP ${res.status}: ${url}`);
    return { buf: Buffer.from(await res.arrayBuffer()), lastModified: res.headers.get('last-modified') };
  };
  const [kospiZip, kosdaqZip] = await Promise.all([get(KIS_MASTER_ZIP_URLS.kospi), get(KIS_MASTER_ZIP_URLS.kosdaq)]);
  return {
    kospi: unzipFirstFile(kospiZip.buf),
    kosdaq: unzipFirstFile(kosdaqZip.buf),
    lastModified: kospiZip.lastModified,
  };
}

function parseMst(buf: Buffer, tailBytes: number, market: 'KOSPI' | 'KOSDAQ'): (MasterStockEntry & { group: string })[] {
  const dec = new TextDecoder('euc-kr');
  const rows: (MasterStockEntry & { group: string })[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    let end = i;
    if (end > start && buf[end - 1] === 0x0d) end--;
    const line = buf.subarray(start, end);
    start = i + 1;
    if (line.length <= tailBytes + 21) continue;
    const head = line.subarray(0, line.length - tailBytes);
    const tail = line.subarray(line.length - tailBytes);
    rows.push({
      symbol: dec.decode(head.subarray(0, 9)).trim(),
      name: dec.decode(head.subarray(21)).trim(),
      market,
      stdCode: dec.decode(head.subarray(9, 21)).trim(),
      group: dec.decode(tail.subarray(0, 2)),
    });
  }
  return rows;
}

/**
 * 두 .mst 파일을 종목 마스터 형식으로 변환. KIS 파일 순서(코스피 → 코스닥)를 그대로 유지한다
 * (정렬하면 stockMasterCache.json diff에 실제 변경분 외의 순서 변경이 섞인다).
 */
export function parseKisMasterFiles(kospi: Buffer, kosdaq: Buffer): MasterStockEntry[] {
  return [...parseMst(kospi, KOSPI_TAIL_BYTES, 'KOSPI'), ...parseMst(kosdaq, KOSDAQ_TAIL_BYTES, 'KOSDAQ')]
    .filter((r) => KRX_SYMBOL_PATTERN.test(r.symbol) && ALLOWED_GROUPS.has(r.group))
    .map((r) => ({ symbol: r.symbol, name: r.name, market: r.market, stdCode: r.stdCode, group: r.group }));
}

export interface StockMasterDiff {
  oldCount: number;
  newCount: number;
  renamed: { symbol: string; oldName: string; name: string }[];
  marketChanged: { symbol: string; name: string; oldMarket: string; market: string }[];
  groupChanged: { symbol: string; name: string; oldGroup: string; group: string }[];
  added: MasterStockEntry[];
  removed: MasterStockEntry[];
  shrinkRatio: number;
  hasChanges: boolean;
  suspicious: boolean; // MAX_SHRINK_RATIO 초과 감소 - 반영/알림 금지
}

export function diffStockMaster(oldList: MasterStockEntry[], newList: MasterStockEntry[]): StockMasterDiff {
  const oldBy = new Map(oldList.map((m) => [m.symbol, m]));
  const newBy = new Map(newList.map((m) => [m.symbol, m]));
  const renamed: StockMasterDiff['renamed'] = [];
  const marketChanged: StockMasterDiff['marketChanged'] = [];
  const groupChanged: StockMasterDiff['groupChanged'] = [];
  const added: MasterStockEntry[] = [];
  for (const m of newList) {
    const o = oldBy.get(m.symbol);
    if (!o) { added.push(m); continue; }
    if (o.name !== m.name) renamed.push({ symbol: m.symbol, oldName: o.name, name: m.name });
    if (o.market !== m.market) marketChanged.push({ symbol: m.symbol, name: m.name, oldMarket: o.market, market: m.market });
    if ((o.group || '') !== (m.group || '')) groupChanged.push({ symbol: m.symbol, name: m.name, oldGroup: o.group || '', group: m.group || '' });
  }
  const removed = oldList.filter((m) => !newBy.has(m.symbol));
  const shrinkRatio = oldList.length > 0 ? (oldList.length - newList.length) / oldList.length : 0;
  const hasChanges = renamed.length + marketChanged.length + groupChanged.length + added.length + removed.length > 0;
  return {
    oldCount: oldList.length,
    newCount: newList.length,
    renamed, marketChanged, groupChanged, added, removed,
    shrinkRatio,
    hasChanges,
    suspicious: shrinkRatio > MAX_SHRINK_RATIO,
  };
}
