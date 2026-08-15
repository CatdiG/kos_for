import { NextRequest, NextResponse } from 'next/server';
import { PRESET_STOCKS, TOP_50_STOCKS } from '@/lib/mockData';
import { buildSearchStockList, resolveSymbolOrName } from '@/lib/stockDictionary';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('query') || '';

    const searchList = buildSearchStockList(PRESET_STOCKS, TOP_50_STOCKS);

    if (!query.trim()) {
      return NextResponse.json({
        total: searchList.length,
        results: searchList.slice(0, 20),
      });
    }

    const queryTrim = query.trim();
    const queryLower = queryTrim.toLowerCase();

    const matchedSymbol = resolveSymbolOrName(queryTrim, searchList);

    const matches = searchList.filter(
      (s) => s.name.toLowerCase().includes(queryLower) || s.symbol.includes(queryLower)
    );

    matches.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === queryLower ? 0 : aName.startsWith(queryLower) ? 1 : 2;
      const bExact = bName === queryLower ? 0 : bName.startsWith(queryLower) ? 1 : 2;
      return aExact - bExact;
    });

    return NextResponse.json({
      query: queryTrim,
      resolvedSymbol: matchedSymbol,
      count: matches.length,
      results: matches.slice(0, 30),
    });
  } catch (err: any) {
    console.error('[API stock/search error]', err);
    return NextResponse.json(
      { error: err?.message || 'Search failed', details: String(err) },
      { status: 500 }
    );
  }
}
