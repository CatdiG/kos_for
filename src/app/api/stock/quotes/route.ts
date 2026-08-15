import { NextRequest, NextResponse } from 'next/server';
import { fetchKisCreditAvailable } from '@/lib/kisApi';
import { resolveStockPriceAndChange } from '@/lib/mockData';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbolsParam = searchParams.get('symbols');

  if (!symbolsParam || symbolsParam.trim() === '') {
    return NextResponse.json({ quotes: {} });
  }

  const symbols = symbolsParam.split(',').map((s) => s.trim()).filter(Boolean);
  const quotes: Record<string, { currentPrice: number; change: number; changeRate: number }> = {};

  // Fetch real KIS quotes for requested symbols asynchronously via kisQueue
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        await fetchKisCreditAvailable(sym);
        const priceInfo = resolveStockPriceAndChange(sym, 0, 0, 0);
        if (priceInfo.currentPrice > 0) {
          quotes[sym] = {
            currentPrice: priceInfo.currentPrice,
            change: priceInfo.change,
            changeRate: priceInfo.changeRate,
          };
        }
      } catch (err) {
        // Ignore individual quote errors
      }
    })
  );

  return NextResponse.json({ quotes }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    },
  });
}
