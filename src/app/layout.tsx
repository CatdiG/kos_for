import type { Metadata } from 'next';
import './globals.css';
import QueryProvider from '@/providers/QueryProvider';
import { ThemeProvider } from '@/providers/ThemeProvider';

export const metadata: Metadata = {
  title: 'KIS 주식 수급 분석 대시보드 | 외국인 · 기관 · 연기금 순매수 추이',
  description:
    '한국투자증권 Open API 기반 실시간 국내주식 외국인, 기관, 연기금 수급 현황 및 5일/20일/60일 누적 순매수 차트 비교 분석',
  keywords: 'KIS, 한국투자증권, 수급분석, 외국인순매수, 기관순매수, 연기금, 주식차트, KOSPI, KOSDAQ',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" className="light" style={{ colorScheme: 'light dark' }}>
      <body className="antialiased bg-slate-50 dark:bg-[#0b0e14] text-slate-900 dark:text-[#e0e3eb] selection:bg-red-500 selection:text-white transition-colors duration-200">
        <ThemeProvider>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
