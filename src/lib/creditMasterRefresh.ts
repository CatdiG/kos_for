// 🎯 [기능 추가 - 사용자 요청: "신용가능 되는 것도 안 된다 뜬다" → 아침 일괄 갱신, 2026-10-06]
// KIS 종목정보 파일(매일 07:35쯤 생성)의 신용가능 필드로 전 종목(약 4,000, ETF 포함) 신용 상태를 kis_credits에
// 한 번에 저장한다 - KIS API 호출 0건. 오라클 상시 수집기(scripts/program-collector.js)가 평일 07:50 KST에 부른다.
// 예전엔 종목별 KIS 조회 결과만 저장했고 24시간이 지나면 버려서, 아침 첫 조회·하루 이상 안 본 종목이 전부
// "확인필요"로 나갔다(실측 2026-10-06 첫 조회: 화면 표시 730칸 중 393칸). 종목별 실시간 조회(fetchKisCreditAvailable)는
// 장중 지정 변경 같은 드문 경우를 위한 보조 경로로 그대로 둔다.
import { downloadKisMasterFiles, parseKisMasterCredits } from '@/lib/stockMasterKisFile';
import { saveCreditBatchToSupabase } from '@/lib/supabase';

// 정상 파일이면 신용 Y/N이 4,000건 안팎(2026-10-06 기준). 이보다 크게 적으면 다운로드가 잘렸거나 형식이 바뀐 것.
const MIN_EXPECTED_CREDIT_ROWS = 3000;
// 파일 Last-Modified가 이보다 오래됐으면 아직 오늘 파일이 아니다(생성 07:35 KST, 실행 07:50 KST 기준).
const MAX_FILE_AGE_MS = 12 * 60 * 60 * 1000;
const SAVE_CHUNK = 500;

export interface CreditMasterRefreshResult {
  status: 'saved' | 'stale_file' | 'too_few_rows' | 'save_failed';
  total: number;
  creditYes: number;
  creditNo: number;
  savedRows: number;
  lastModified: string | null;
}

export async function refreshCreditsFromKisMaster(): Promise<CreditMasterRefreshResult> {
  const files = await downloadKisMasterFiles();
  const credits = parseKisMasterCredits(files.kospi, files.kosdaq);
  const total = credits.size;
  const creditYes = [...credits.values()].filter(Boolean).length;
  const base = { total, creditYes, creditNo: total - creditYes, savedRows: 0, lastModified: files.lastModified };

  const modifiedMs = files.lastModified ? new Date(files.lastModified).getTime() : NaN;
  if (!Number.isFinite(modifiedMs) || Date.now() - modifiedMs > MAX_FILE_AGE_MS) {
    return { ...base, status: 'stale_file' };
  }
  if (total < MIN_EXPECTED_CREDIT_ROWS) {
    return { ...base, status: 'too_few_rows' };
  }

  const entries = [...credits].map(([symbol, isCredit]) => ({ symbol, is_credit: isCredit }));
  let savedRows = 0;
  for (let i = 0; i < entries.length; i += SAVE_CHUNK) {
    const chunk = entries.slice(i, i + SAVE_CHUNK);
    if (!(await saveCreditBatchToSupabase(chunk))) {
      return { ...base, savedRows, status: 'save_failed' };
    }
    savedRows += chunk.length;
  }
  return { ...base, savedRows, status: 'saved' };
}
