import { NextResponse } from 'next/server';
import { resolveAndCacheMissingCredits } from '@/lib/kisApi';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Test symbols for batch credit check (7 stocks)
  const testSymbols = ['005930', '000660', '035420', '009150', '096770', '034020', '011070'];
  console.log('=====================================================');
  console.log(`🧪 [BATCH CREDIT TEST] Executing resolveAndCacheMissingCredits with ${testSymbols.length} uncached symbols...`);
  const start = Date.now();

  await resolveAndCacheMissingCredits(testSymbols);

  const elapsed = Date.now() - start;
  console.log(`[BATCH CREDIT TEST] Finished in ${elapsed}ms`);
  console.log('=====================================================');

  return NextResponse.json({
    success: true,
    symbolsCount: testSymbols.length,
    symbols: testSymbols,
    elapsedMs: elapsed,
    logNotice: `Look at the server terminal log above for "[Supabase kis_credits Saved] 7개 종목 신용상태 DB 저장 완료 (성공: true)"`,
  });
}
