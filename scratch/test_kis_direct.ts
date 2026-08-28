import { fetchOverlapRankingData } from '../src/lib/kisApi';

async function main() {
  console.log('Testing fetchOverlapRankingData directly...');
  try {
    const res = await fetchOverlapRankingData('buy', '1d', 2, 10, 'ALL');
    console.log(`Success! Total items: ${res.list.length}`);
  } catch (err: any) {
    console.error('Direct Exception:', err?.stack || err);
  }
}

main();
