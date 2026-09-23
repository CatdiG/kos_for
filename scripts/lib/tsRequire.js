// Node에서 src/lib의 TypeScript 소스를 그대로 require하기 위한 로더 - scripts/* 공용(수칙 1-6).
// 사이트(Next.js)와 같은 코드를 오라클 서버 수집기(program-collector.js)·종목 마스터 재생성 스크립트에서도
// 복사 없이 재사용하려는 목적이다(같은 로직을 따로 짜면 사이트와 결과가 어긋날 위험).
// typescript 패키지로 파일 단위 변환만 한다(타입 검사는 하지 않음 - 타입 검사는 사이트 빌드/tsc가 담당).
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

let registered = false;

function registerTsRequire() {
  if (registered) return;
  registered = true;

  require.extensions['.ts'] = (module, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
      fileName: filename,
    });
    module._compile(out.outputText, filename);
  };

  // tsconfig의 '@/*' → './src/*' 별칭을 Node 해석기에도 알려준다
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request.startsWith('@/')) {
      request = path.join(PROJECT_ROOT, 'src', request.slice(2));
    }
    return originalResolve.call(this, request, parent, ...rest);
  };
}

module.exports = { registerTsRequire, PROJECT_ROOT };
