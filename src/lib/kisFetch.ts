import { getKisAccessToken } from './kisApi';

/**
 * 기존 메모리 캐싱 토큰(getKisAccessToken)을 재사용하고
 * 모든 KIS API 호출에 `cache: 'no-store'`를 강제 적용하는 KIS Fetch Wrapper
 */
export async function getKisToken(): Promise<string | null> {
  return getKisAccessToken();
}

export async function kisFetch<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const token = await getKisToken();

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store', // ← 모든 KIS 호출에 강제 적용
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`KIS API 호출 실패: ${res.status} ${url} - ${errorText}`);
  }

  return res.json();
}
