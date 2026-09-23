import { NextResponse } from 'next/server';
import { getMasterStockList } from '@/lib/stockDictionary';
import { downloadKisMasterFiles, parseKisMasterFiles, diffStockMaster } from '@/lib/stockMasterKisFile';

// 배포된 사이트가 스스로 "종목 마스터(빌드에 포함된 stockMasterCache.json)가 KIS 최신 종목정보 파일과 다른지"
// 확인하는 API. 헤더의 StockMasterStatusBadge가 화면 로드 후 백그라운드로 호출해, 차이가 있을 때만
// "종목 목록 갱신 필요" 배지를 띄운다. 반영은 배지 링크 → GitHub Actions 수동 실행(stock-master-apply.yml).
// 크론을 새로 만들지 않는다(Vercel 크론 이미 17개) - 요청 시점에 확인하고 결과를 캐시한다.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// 확인 주기: 하루 한 번(KST 08:00 기준). KIS 종목정보 파일 내용은 하루 한 번 07:35경에 만들어진다(2026-09-23
// 실측: 저녁에 다시 올라온 파일도 zip 내부 생성시각 07:35·내용 바이트 동일, 당일 첫 거래 0010S0이 07:35 파일에 포함).
// 그래서 08:00 이후 첫 요청에서만 KIS 파일을 받고, 다음 날 08:00 전까지는 그 결과를 재사용한다.
// 실패하면 1시간 뒤 재시도(같은 날 안에서).
const CHECK_HOUR_KST = 8;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
// 배지 팝업에 보여줄 항목 수 상한(응답 크기 제한) - 전체 개수는 counts로 따로 준다
const LIST_LIMIT = 30;

const APPLY_WORKFLOW_URL = 'https://github.com/CatdiG/kos_for/actions/workflows/stock-master-apply.yml';

type MasterStatusBody =
  | {
      status: 'up_to_date' | 'update_needed';
      checkedAt: string;
      kisLastModified: string | null;
      counts: { renamed: number; marketChanged: number; groupChanged: number; added: number; removed: number };
      renamed: { symbol: string; oldName: string; name: string }[];
      marketChanged: { symbol: string; name: string; oldMarket: string; market: string }[];
      added: { symbol: string; name: string; market: string }[];
      removed: { symbol: string; name: string }[];
      applyWorkflowUrl: string;
    }
  | { status: 'check_error'; checkedAt: string; error: string };

let cached: { windowKey: string; at: number; body: MasterStatusBody } | null = null;

/**
 * 현재 시각이 속한 "확인 주기" 키 = 가장 최근 KST 08:00의 날짜(YYYYMMDD).
 * 예: 9/24 07:59 → '20260923'(전날 08:00 주기), 9/24 08:00 → '20260924'.
 */
function currentCheckWindowKey(nowMs: number): string {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000); // UTC 기준 필드로 KST 값을 읽기 위한 이동
  if (kst.getUTCHours() < CHECK_HOUR_KST) kst.setUTCDate(kst.getUTCDate() - 1);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
}

async function computeStatus(): Promise<MasterStatusBody> {
  const checkedAt = new Date().toISOString();
  try {
    const files = await downloadKisMasterFiles();
    const latest = parseKisMasterFiles(files.kospi, files.kosdaq);
    const d = diffStockMaster(getMasterStockList(), latest);
    // 종목 수가 비정상적으로 줄었으면(다운로드 잘림/형식 변경 의심) "갱신 필요"로 띄우지 않는다 -
    // 배지를 믿고 반영했다가 검색 목록이 대량 삭제되는 일을 막는다(반영 스크립트도 같은 기준으로 중단).
    if (d.suspicious) {
      return { status: 'check_error', checkedAt, error: `종목 수 ${(d.shrinkRatio * 100).toFixed(1)}% 감소 - 파일 이상 의심` };
    }
    return {
      status: d.hasChanges ? 'update_needed' : 'up_to_date',
      checkedAt,
      kisLastModified: files.lastModified,
      counts: {
        renamed: d.renamed.length,
        marketChanged: d.marketChanged.length,
        groupChanged: d.groupChanged.length,
        added: d.added.length,
        removed: d.removed.length,
      },
      renamed: d.renamed.slice(0, LIST_LIMIT),
      marketChanged: d.marketChanged.slice(0, LIST_LIMIT),
      added: d.added.slice(0, LIST_LIMIT).map((m) => ({ symbol: m.symbol, name: m.name, market: m.market })),
      removed: d.removed.slice(0, LIST_LIMIT).map((m) => ({ symbol: m.symbol, name: m.name })),
      applyWorkflowUrl: APPLY_WORKFLOW_URL,
    };
  } catch (e) {
    return { status: 'check_error', checkedAt, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const now = Date.now();
  const windowKey = currentCheckWindowKey(now);
  const stale =
    !cached ||
    cached.windowKey !== windowKey ||
    (cached.body.status === 'check_error' && now - cached.at > FAILURE_RETRY_MS);
  if (stale) {
    const body = await computeStatus();
    if (body.status === 'check_error') console.error('[master-status] 종목 마스터 확인 실패:', body.error);
    cached = { windowKey, at: now, body };
  }
  return NextResponse.json(cached!.body);
}
