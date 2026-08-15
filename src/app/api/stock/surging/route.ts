import { NextRequest, NextResponse } from 'next/server';
import { fetchKisSurgingStocks } from '@/lib/kisApi';
import { MarketType, SurgingMode } from '@/lib/types';
// HMR re-eval

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const modeParam = (searchParams.get('mode') || 'fluctuation') as SurgingMode;
  const market = (searchParams.get('market') as MarketType) || 'ALL';

  const validModes: SurgingMode[] = ['fluctuation', 'volume', 'amount', 'overlap', 'comprehensive'];
  const mode: SurgingMode = validModes.includes(modeParam) ? modeParam : 'fluctuation';

  try {
    const data = await fetchKisSurgingStocks(mode, market);
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error: any) {
    console.error('[API Surging Error]', error);
    return NextResponse.json(
      { error: error?.message || '급등주 순위 데이터를 불러오는 도중 오류가 발생했습니다.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0, must-revalidate',
        },
      }
    );
  }
}
