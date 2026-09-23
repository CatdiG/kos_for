'use client';

// "종목 목록 갱신 필요" 헤더 배지 - Header.tsx(데스크톱)/MobileHeader.tsx(모바일) 공용(수칙 1-6).
// 배포된 사이트가 /api/stock/master-status로 빌드에 포함된 종목 마스터와 KIS 최신 종목정보 파일을 비교해,
// 차이가 있을 때만 배지를 띄운다(차이 없음/확인 실패면 아무것도 안 그림 - 화면 소음 방지).
// 배지를 누르면 변경 목록과 "GitHub에서 반영 실행" 링크가 뜬다 - 링크의 Run workflow를 누르면 클라우드에서
// 재생성·커밋·배포된다(사용자가 누를 때만 배포 - 수칙 1-8). PC를 켜지 않아도 휴대폰으로 반영 가능.
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ExternalLink, X } from 'lucide-react';

interface MasterStatus {
  status: 'up_to_date' | 'update_needed' | 'check_error';
  checkedAt: string;
  kisLastModified?: string | null;
  counts?: { renamed: number; marketChanged: number; groupChanged: number; added: number; removed: number };
  renamed?: { symbol: string; oldName: string; name: string }[];
  marketChanged?: { symbol: string; name: string; oldMarket: string; market: string }[];
  added?: { symbol: string; name: string; market: string }[];
  removed?: { symbol: string; name: string }[];
  applyWorkflowUrl?: string;
}

export default function StockMasterStatusBadge({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<MasterStatus | null>(null);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 화면 로드를 막지 않도록 마운트 후 백그라운드로 1회 조회(서버가 하루 한 번, KST 08:00 기준으로 확인·캐시)
  useEffect(() => {
    let alive = true;
    fetch('/api/stock/master-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setData(j); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!data || data.status !== 'update_needed' || !data.counts) return null;

  const c = data.counts;
  const parts = [
    c.added ? `신규상장 ${c.added}` : '',
    c.renamed ? `사명변경 ${c.renamed}` : '',
    c.removed ? `상장폐지 ${c.removed}` : '',
    c.marketChanged ? `시장이전 ${c.marketChanged}` : '',
    c.groupChanged ? `분류변경 ${c.groupChanged}` : '',
  ].filter(Boolean);

  const Section = ({ title, rows }: { title: string; rows: string[] }) =>
    rows.length === 0 ? null : (
      <div className="mb-2">
        <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200 mb-1">{title}</div>
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r} className="text-[11px] font-mono text-slate-600 dark:text-slate-300 break-keep">{r}</li>
          ))}
        </ul>
      </div>
    );

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700/60 text-amber-800 dark:text-amber-300 font-semibold cursor-pointer ${
          compact ? 'px-2 py-1.5 rounded-lg text-[10px]' : 'px-3 py-1.5 rounded-xl text-xs'
        }`}
        title="KIS 최신 종목정보와 다른 종목이 있습니다 - 눌러서 확인"
      >
        <RefreshCw className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
        <span>{compact ? '종목 갱신' : `종목 목록 갱신 필요 · ${parts.join(' · ')}`}</span>
      </button>

      {open && (
        // 모바일(compact)은 배지가 화면 가운데쯤이라 배지 기준 absolute로 펼치면 왼쪽이 화면 밖으로 잘린다(실측) -
        // 화면 폭 기준 fixed(좌우 12px 여백)로 띄운다. 데스크톱은 배지 아래 오른쪽 정렬.
        <div
          className={`${
            compact ? 'fixed left-3 right-3 top-14' : 'absolute right-0 top-full mt-2 w-80'
          } max-h-96 overflow-y-auto bg-white dark:bg-[#1e222d] border border-slate-200 dark:border-[#2a2e39] rounded-xl shadow-2xl z-[60] p-3`}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="text-xs font-bold text-slate-900 dark:text-white">종목 목록 갱신 필요</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400">{parts.join(' · ')}</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="닫기" className="p-0.5 text-slate-400">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <Section title="신규 상장" rows={(data.added || []).map((m) => `${m.symbol} ${m.name} (${m.market})`)} />
          <Section title="사명 변경" rows={(data.renamed || []).map((m) => `${m.symbol} ${m.oldName} → ${m.name}`)} />
          <Section title="상장폐지 등" rows={(data.removed || []).map((m) => `${m.symbol} ${m.name}`)} />
          <Section title="시장 이전" rows={(data.marketChanged || []).map((m) => `${m.symbol} ${m.name} ${m.oldMarket}→${m.market}`)} />
          {Object.values(c).some((n) => n > 30) && (
            <div className="text-[10px] text-slate-400 mb-2">항목별 최대 30개까지만 표시</div>
          )}

          {data.applyWorkflowUrl && (
            <a
              href={data.applyWorkflowUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-bold"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              GitHub에서 반영 실행
            </a>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
            열린 페이지에서 <b>Run workflow</b> → <b>Run workflow</b>를 누르면 클라우드에서 종목 목록을 다시 만들어
            배포합니다(약 2~3분). 확인 시각: {new Date(data.checkedAt).toLocaleString('ko-KR', { hour12: false })}
          </p>
        </div>
      )}
    </div>
  );
}
