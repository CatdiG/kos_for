// [종목 마스터 재생성] src/lib/data/stockMasterCache.json을 KIS 공식 종목정보 파일로 다시 만든다.
// 배경: 이 파일은 첫 배포(2026-08-16) 이후 갱신 이력이 없어서 사명변경 종목(코윈테크→코윈로보틱스 등)이
// 새 이름으로 검색되지 않았고, 영숫자 신코드 상장주(0126Z0 삼성에피스홀딩스 등)가 아예 빠져 있었다.
//
// 운영 흐름: 배포된 사이트가 /api/stock/master-status로 스스로 차이를 확인해 헤더에 "종목 목록 갱신 필요" 배지를
// 띄우고, 사용자가 배지의 링크로 GitHub Actions 수동 실행 워크플로(.github/workflows/stock-master-apply.yml)를
// 누르면 이 스크립트가 클라우드에서 돌아 main에 커밋 → Vercel 배포된다(사용자가 누를 때만 배포 - 수칙 1-8).
//
// 사용:
//   node scripts/regenerate_stock_master_cache.js --download [--write] [--summary-file <경로>]
//   node scripts/regenerate_stock_master_cache.js <mst폴더> [--write] [--summary-file <경로>]
//   --write 없으면 비교 결과만 출력(dry-run). --summary-file은 마크다운 요약을 쓴다(워크플로 실행 요약용).
//
// 다운로드·압축해제·파싱·비교 로직은 사이트 API와 같은 src/lib/stockMasterKisFile.ts를 그대로 쓴다(수칙 1-6).
// 그 파일이 TypeScript라 typescript 패키지(devDependency)로 즉석 변환해 불러온다.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
  });
  module._compile(out.outputText, filename);
};
const { downloadKisMasterFiles, parseKisMasterFiles, diffStockMaster, MAX_SHRINK_RATIO } = require('../src/lib/stockMasterKisFile.ts');

const args = process.argv.slice(2);
const DOWNLOAD = args.includes('--download');
const WRITE = args.includes('--write');
const summaryIdx = args.indexOf('--summary-file');
const SUMMARY_FILE = summaryIdx >= 0 ? args[summaryIdx + 1] : null;
const MST_DIR = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--summary-file');
if (!DOWNLOAD && !MST_DIR) {
  console.error('사용법: node scripts/regenerate_stock_master_cache.js (--download | <mst폴더>) [--write] [--summary-file <경로>]');
  process.exit(1);
}

const MASTER_PATH = path.join(__dirname, '..', 'src', 'lib', 'data', 'stockMasterCache.json');

async function main() {
  let kospi, kosdaq, lastModified = null;
  if (DOWNLOAD) {
    ({ kospi, kosdaq, lastModified } = await downloadKisMasterFiles());
    console.log(`[다운로드] KIS 종목정보 파일 Last-Modified: ${lastModified || '(없음)'}`);
  } else {
    kospi = fs.readFileSync(path.join(MST_DIR, 'kospi_code.mst'));
    kosdaq = fs.readFileSync(path.join(MST_DIR, 'kosdaq_code.mst'));
  }

  const next = parseKisMasterFiles(kospi, kosdaq);
  const oldMaster = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));
  const d = diffStockMaster(oldMaster, next);

  console.log(`[결과] 기존 ${d.oldCount}개 → 신규 ${d.newCount}개`);
  console.log(`- 이름 변경 ${d.renamed.length} / 시장 변경 ${d.marketChanged.length} / 그룹 변경 ${d.groupChanged.length} / 신규 ${d.added.length} / 제거 ${d.removed.length}`);
  d.renamed.forEach((m) => console.log(`    [이름] ${m.symbol}  "${m.oldName}" → "${m.name}"`));
  d.marketChanged.forEach((m) => console.log(`    [시장] ${m.symbol}  ${m.name}  ${m.oldMarket} → ${m.market}`));
  d.groupChanged.forEach((m) => console.log(`    [그룹] ${m.symbol}  ${m.name}  ${m.oldGroup || '(없음)'} → ${m.group}`));
  d.added.forEach((m) => console.log(`    [신규] ${m.symbol}  ${m.name}  (${m.market}, ${m.group})`));
  d.removed.forEach((m) => console.log(`    [제거] ${m.symbol}  ${m.name}`));

  if (SUMMARY_FILE) {
    const lines = [];
    const table = (title, rows, fmt) => {
      if (rows.length === 0) return;
      lines.push(`### ${title} (${rows.length})`, '', '| 코드 | 내용 |', '|---|---|');
      rows.forEach((m) => lines.push(`| \`${m.symbol}\` | ${fmt(m)} |`));
      lines.push('');
    };
    lines.push('## 종목 마스터 갱신 (KIS 공식 종목정보 파일 기준)', '');
    if (lastModified) lines.push(`- KIS 파일 Last-Modified: ${lastModified}`);
    lines.push(`- 종목 수: ${d.oldCount} → ${d.newCount}`);
    lines.push(`- 이름 변경 ${d.renamed.length} · 시장 변경 ${d.marketChanged.length} · 그룹 변경 ${d.groupChanged.length} · 신규 ${d.added.length} · 제거 ${d.removed.length}`, '');
    table('이름 변경', d.renamed, (m) => `${m.oldName} → **${m.name}**`);
    table('시장 변경', d.marketChanged, (m) => `${m.name}: ${m.oldMarket} → ${m.market}`);
    table('그룹 변경', d.groupChanged, (m) => `${m.name}: ${m.oldGroup || '(없음)'} → ${m.group}`);
    table('신규 상장', d.added, (m) => `${m.name} (${m.market}, ${m.group})`);
    table('제거 (상장폐지 등)', d.removed, (m) => m.name);
    lines.push('백테스트 데이터(scratch 백필)는 자동으로 갱신되지 않으니 필요하면 `--only-missing` 증분 백필을 따로 실행하세요.');
    fs.writeFileSync(SUMMARY_FILE, lines.join('\n') + '\n', 'utf8');
    console.log(`\n요약 저장: ${SUMMARY_FILE}`);
  }

  if (d.suspicious) {
    console.error(`\n❌ 중단: 종목 수가 ${(d.shrinkRatio * 100).toFixed(1)}% 줄었습니다(허용 ${MAX_SHRINK_RATIO * 100}%). 다운로드 잘림 또는 파일 형식 변경 의심 - 파일을 쓰지 않습니다.`);
    process.exit(2);
  }

  if (WRITE) {
    fs.writeFileSync(MASTER_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`✅ ${MASTER_PATH} 저장 완료${d.hasChanges ? '' : ' (변경 없음)'}`);
  } else {
    console.log('(dry-run: --write 없이 실행 - 파일 변경 없음)');
  }
}

main().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
