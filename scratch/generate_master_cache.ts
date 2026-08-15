import { refreshStockMasterCache } from '../src/lib/stockMasterManager';

async function generate() {
  console.log('Generating initial stock master JSON cache...');
  const stocks = await refreshStockMasterCache();
  console.log(`Generated cache with ${stocks.length} stocks successfully!`);
}

generate().catch(console.error);
