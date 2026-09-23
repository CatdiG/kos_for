// 장마감 후보군(발굴/눌림후속) 스냅샷의 "기준 시각" 라벨 - discovery/route.ts, precursor/route.ts 공용(수칙 1-6).
// 🚨 [버그 수정 - 수칙 1-5, 2026-09-23] 예전엔 두 라우트가 "14:30 기준"/"14:40 기준"을 코드에 고정해 표시했다.
// 그런데 Vercel Hobby 크론은 예약 시각보다 최대 59분 늦게 돈다(공식 문서 "Per-hour (±59 min)", 실측: 발굴 14:30
// 예약 → 15:12 저장 3일 연속, 눌림후속 14:40 예약 → 15:25 저장). 실제 계산 시각이 아닌 예약 시각을 기준 시각처럼
// 보여주는 건 사실과 다르므로, 스냅샷이 실제로 저장된 시각(created_at)을 표시한다.
import { formatKstHHMM } from './kisApi';

export function buildSnapshotBatchLabel(params: {
  date: string | null; // 스냅샷 날짜 YYYYMMDD
  todayYmd: string; // 오늘 KST YYYYMMDD
  rows: { created_at?: string }[];
  scheduleText: string; // 예약 안내 문구(아직 계산 전일 때만 사용). 예: '14:15'
}): string {
  const { date, todayYmd, rows, scheduleText } = params;
  if (!date) {
    return `아직 계산되지 않았습니다 (매 거래일 ${scheduleText} 예약 · 실제 실행은 최대 1시간 늦을 수 있음)`;
  }
  const dateLabel = `${date.slice(4, 6)}/${date.slice(6, 8)}`;
  // 한 번의 크론 실행에서 같이 저장된 행들이라 created_at이 거의 같다 - 가장 이른 값을 계산 시각으로 쓴다
  const createdMs = rows
    .map((r) => (r.created_at ? Date.parse(r.created_at) : NaN))
    .filter((t) => Number.isFinite(t));
  const timeText = createdMs.length > 0 ? `${formatKstHHMM(Math.min(...createdMs))} 계산` : '계산 시각 미상';
  return date === todayYmd
    ? `${dateLabel} ${timeText}`
    : `${dateLabel} ${timeText} (다음 계산 전까지 최근 결과 유지 중)`;
}
