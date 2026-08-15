import { getStockName, resolveSymbolOrName, buildSearchStockList } from '../src/lib/stockDictionary';

console.log('--- Testing Stock Resolution ---');
const list = buildSearchStockList();
console.log('Total search list count:', list.length);

const symbol = resolveSymbolOrName('대원전선', list);
console.log('Resolved symbol for "대원전선":', symbol);

const stockName = getStockName(symbol);
console.log('Stock name for symbol:', stockName);
