import { NextRequest, NextResponse } from 'next/server';
import { PRESET_STOCKS, TOP_50_STOCKS } from '@/lib/mockData';
import { buildSearchStockList, filterSearchStockList, resolveSymbolOrName } from '@/lib/stockDictionary';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('query') || searchParams.get('q') || '';

    const searchList = buildSearchStockList(PRESET_STOCKS, TOP_50_STOCKS);

    if (!query.trim()) {
      return NextResponse.json({
        total: searchList.length,
        results: searchList.slice(0, 20),
      });
    }

    const queryTrim = query.trim();

    const matchedSymbol = resolveSymbolOrName(queryTrim, searchList);

    // count는 기존처럼 전체 매칭 수를 준다(limit 없이 한 번 필터 후 앞 30개만 결과로 반환)
    const matches = filterSearchStockList(searchList, queryTrim, Number.MAX_SAFE_INTEGER);

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
