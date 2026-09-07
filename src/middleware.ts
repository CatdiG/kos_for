import { NextRequest, NextResponse } from 'next/server';

// 🚨 [신규 기능] 모바일 기기로 접속하면 자동으로 모바일 전용 페이지로 이동시킨다 - 사용자가 실제
// 375px 화면에서 확인해보니 데스크톱 페이지(코스피/코스닥 카드, 매매순위 테이블)가 가로로 잘려 실사용이
// 어려웠다(수칙 1-4: 화면 클릭 전 실제 렌더링 확인 후 작업). 데스크톱 코드는 전혀 건드리지 않고 별도
// 라우트/컴포넌트로 분리했다(src/app/m, src/app/m/history, src/components/mobile).
//
// 판정 우선순위: 1) view 쿠키(사용자가 수동으로 전환한 경우) > 2) User-Agent 자동 판정.
// iPad는 최신 Safari가 데스크톱 UA를 보내는 게 일반적이라(데스크톱형 레이아웃이 실제로도 더 잘 맞음)
// 자동 판정 대상에서 제외한다 - 필요하면 나중에 화면폭 기반 판정을 追加할 수 있다.
// 🚨 [버그 수정] 이 프로젝트는 src/app 구조라 middleware.ts를 프로젝트 루트에 두면 Next.js가 전혀
// 인식하지 못한다(실측 확인: 루트에 뒀을 때 리다이렉트가 아예 발생하지 않음) - src/ 안으로 옮겨야 한다.
const MOBILE_UA_PATTERN = /Mobi|Android/i;
const VIEW_COOKIE = 'view';
const VIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30일

// 데스크톱 경로 → 모바일 경로 매핑. 히스토리 페이지 추가하면서 '/'만 다루던 걸 일반화했다(수칙 1-6).
const DESKTOP_TO_MOBILE: Record<string, string> = {
  '/': '/m',
  '/history': '/m/history',
};
const MOBILE_TO_DESKTOP: Record<string, string> = { '/m': '/', '/m/history': '/history' };

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  // 수동 전환 링크(?view=desktop / ?view=mobile) 처리: 쿠키에 저장하고 쿼리 없는 URL로 리다이렉트.
  // 지금 보고 있던 화면(홈/히스토리)에 대응하는 반대쪽 화면으로 보낸다 - 히스토리 보다가 데스크톱
  // 전환을 누르면 홈이 아니라 데스크톱 히스토리로 가야 한다.
  const viewParam = searchParams.get('view');
  if (viewParam === 'desktop' || viewParam === 'mobile') {
    const target = viewParam === 'mobile'
      ? (DESKTOP_TO_MOBILE[pathname] || '/m')
      : (MOBILE_TO_DESKTOP[pathname] || '/');
    const res = NextResponse.redirect(new URL(target, request.url));
    res.cookies.set(VIEW_COOKIE, viewParam, { maxAge: VIEW_COOKIE_MAX_AGE, path: '/' });
    return res;
  }

  // 이미 모바일 경로(/m, /m/history) 자체는 그대로 통과(데스크톱 UA로 직접 접속해도 강제로 되돌리지
  // 않음 - 링크 공유 허용).
  if (!(pathname in DESKTOP_TO_MOBILE)) {
    return NextResponse.next();
  }

  const cookieView = request.cookies.get(VIEW_COOKIE)?.value;
  if (cookieView === 'desktop') return NextResponse.next();
  if (cookieView === 'mobile') return NextResponse.redirect(new URL(DESKTOP_TO_MOBILE[pathname], request.url));

  const ua = request.headers.get('user-agent') || '';
  if (MOBILE_UA_PATTERN.test(ua)) {
    return NextResponse.redirect(new URL(DESKTOP_TO_MOBILE[pathname], request.url));
  }

  return NextResponse.next();
}

// API 라우트/정적 자산은 미들웨어를 타지 않도록 페이지 라우트만 대상으로 한다 - 매 API 호출마다
// 불필요한 지연이 생기는 걸 막는다.
export const config = {
  matcher: ['/', '/m', '/history', '/m/history'],
};
