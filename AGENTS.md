<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Mandatory Verification & Anti-Regression Rules (필수 검증 및 회귀 방지 수칙)

Any AI assistant working on this codebase MUST strictly follow these rules for EVERY task, edit, or refactoring without exception:

## 1. No Superficial Status Code Verification (겉핥기식 200 OK 판별 절대 금지)
- NEVER declare a feature "working" or "normal" based solely on HTTP 200 status codes or boolean `true` returns.
- You MUST empirically measure actual runtime response latency (in milliseconds) and verify data integrity under real KIS OpenAPI call conditions.

## 2. Mandatory Line-by-Line Git Diff Audit (코드 변경점 1줄 대조 필수)
- Before reporting completion or answering regression questions, run `git diff` on all modified files (`kisApi.ts`, `batchCollector.ts`, `InvestorRankingTable.tsx`, etc.).
- Explicitly check if previous optimizations (parallel `Promise.all`, candidate limits, memory caches, organ fallbacks) were accidentally lost or overwritten.

## 3. Mandatory 9-Item Full Regression Checklist (코드 수정 시 9대 핵심 항목 매번 전수 재검증)
No matter how small the code modification is, you MUST re-verify ALL 9 items below before concluding your work and provide raw execution output as proof:

1. **Investor Rankings 4 Types (매매순위 4종)**: Foreign, Organ, Pension, Program (외국인 · 기관 · 연기금 · 프로그램) rankings load clean data with non-zero fallback dates when applicable.
2. **Supply Overlap (수급교집합)**: Displays multi-entity overlap badges (e.g. `4개 주체 중복`) with response time under 500ms (cached/parallelized).
3. **Surging Stocks (급등주 순위)**: Fluctuation, Volume, Amount sub-modes render correctly with 60s auto-refresh interval.
4. **Comprehensive Scalping Ranking (단타 종합랭킹)**: Total score RMS calculation, slider weights, and 7 detail metrics compute properly.
5. **3-State Credit Status (신용가능 3-상태)**: 100% DB/file cached credit eligibility status checks (`가능`, `불가`, `미확인`) without runtime crashes.
6. **Pension Fund Exposure (연기금 노출)**: Major pension-heavy stocks (e.g., Samsung Electro-Mechanics 009150) correctly display pension ranks and fallback labels.
7. **Top 4 Summary Cards (상단 4개 카운터 카드)**: Foreigner, Institution, Pension Fund, Program Trading summary cards display consistent fallback dates `(8/27 기준)` and amounts.
8. **Overlap Search Range Limits (탐색범위 10 · 20 · 30 · 50)**: Switching overlap candidate limits dynamically adjusts dataset limits without timing out.
9. **Trend Alignment Badges (정배열/이격도 추세 배지)**: Dynamic status badges (`🔵 바닥 반등`, `🔥 상승 추세`, etc.) compute accurately from moving averages.

## 4. Evidence-Based Output (Raw 증빙 로그 첨부 필수)
- Never answer with verbal assurances alone. Always execute testing scripts and attach the raw terminal logs showing exact latencies (ms) and stock output items to prove full functionality.

## 5. End-to-End Dual Verification & Script Execution Rule (백엔드 API + 프론트엔드 UI 검증 및 스크립트 실행 규칙)
- **실행 타이밍 수칙 (사용자 명시적 지시)**:
  1. 세션 최초 시작 시 / 대규모 리팩토링 완료 시 1회 자동 검증을 수행한다.
  2. 대화 진행 중 디자인/UI 미세 조정 단계에서는 **사용자가 명시적으로 검증/테스트 실행을 요청할 때에만 검증 스크립트(`node scratch/...`)를 실행**한다. (매 프롬프트마다 15~20초 소요되는 KIS API 실시간 스크립트를 무분별하게 실행하여 응답 속도를 저하시키는 행위를 절대 금지한다).
- 기능 완료 검증 시에는 React 프론트엔드 컴포넌트(`InvestorRankingTable.tsx` 등)가 해당 필드(`consecutiveText`, `ranksByType`, `aiPickRank` 등)를 JSX DOM 트리에 정상 소비하는지 확인한다.

## 6. Environment Disclosure Rule (검증 환경 명시 필수)
- Every verification log MUST explicitly state whether it ran against local dev (npm run dev), a simulated/mocked script, or the actual deployed production URL. Never present a local/simulated result without this label.
- Claims specific to production behavior (e.g., cold start latency, serverless instance isolation, cron execution) MUST be verified against the actual deployed URL — a local Node process is not a valid substitute and must not be labeled as such.

## 7. Duplicate Logic Audit (동일 로직 중복 구현 검사 필수)
- Before declaring any bug fixed, search the ENTIRE codebase for other implementations of the same computation/state (e.g., `grep -n` for the field name being fixed, such as `isCreditAvailable =`, `statusBadge`, lock variables).
- If more than one implementation exists, either consolidate them into a single shared function (Single Source of Truth) or explicitly justify why duplication is necessary.

## 8. Adversarial Reproduction Rule (실제 장애 조건 재현 필수)
- When verifying a fix for a concurrency/timing bug, the test MUST actively recreate the original failure condition (e.g., trigger the slow batch process, THEN fire the allegedly-independent request in parallel) — not just call the fixed endpoint in isolation when the system happens to be idle.

## 9. Fallback Data Labeling Rule (대체 데이터 출처일 명시 필수)
- Any time any field falls back to a previous trading day's value (because today's value is 0/uncollected), the UI and API response MUST explicitly label the reference date (e.g., "(8/27 기준)"). Never present stale data as if it were today's value.

## 10. Full History Review Scope (검토 범위는 세션이 아닌 전체 변경 이력)
- The Git diff audit (Rule 2) MUST cover the full history of this feature's development (e.g., `git log --since="7 days ago"`), not just the current session's commits. A regression can be introduced by a commit from a previous day/session.

## 11. No Absolute Claims Without Counter-Test (단정적 표현 금지)
- Phrases like "100% resolved", "structurally impossible", or "completely eliminated" require an accompanying test that actively tried to break the fix and failed to do so. Without such a counter-test, use qualified language (e.g., "verified under the tested conditions").

## 12. Tiered Testing Rule (전체/부분 검증 구분)
- FULL 9-item suite required when: (a) about to deploy, or (b) any edit touches a shared core file (`kisApi.ts`, `batchCollector.ts`, or any file used by 3+ features).
- PARTIAL testing (only the directly affected item(s)) is sufficient when the edit is isolated to a single UI component or a single, non-shared function.
- Before choosing PARTIAL, you MUST first check (via grep/diff) whether the changed code is referenced elsewhere. If it is referenced by other features, treat it as a shared core file and run the FULL suite instead.
## 13. Overlap Golden Snapshot Regression Audit Rule (수급교집합 골든 스냅샷 검증 수칙)
- Whenever modifying `kisApi.ts` or `batchCollector.ts` or any code affecting overlap rankings, you MUST execute `node scratch/verify_overlap_regression.js` BEFORE reporting completion.
- The script automatically compares current live API responses against `scratch/overlap_golden_snapshot.json` to detect diffs in rank, credit status, status badges, and 3D overlap items.
- Distinguish between "Intended Normal Market Update" (real market price/volume movement) vs "Regression Bug" (badge regressed to '확인필요', credit status lost, forced 20-item limit truncation).
- If a regression bug is detected, FIX THE BUG FIRST before updating the golden snapshot.
- Update the golden snapshot (`node scratch/create_golden_snapshot.js`) ONLY when changes are confirmed to be intended, valid feature updates/improvements. NEVER overwrite arbitrarily.

## 14. Overlap Golden Snapshot Rule (수급교집합 전용 회귀 감지)
- overlap(수급교집합) depends on foreign/organ/pension/program
  rankings, credit status, and trend badges — it is the most
  fragile integration point in this codebase.
- ANY edit to `kisApi.ts`, `batchCollector.ts`, or any credit/badge
  computation MUST run `scratch/verify_overlap_regression.js`
  against the golden snapshot BEFORE reporting completion, in
  addition to (not instead of) Rule 3's 9-item checklist.
- A diff against the golden snapshot must be explicitly explained
  as either an intended data change or a regression — never
  silently overwritten.



