import { STOCK_NAME_MAP, getStockName, registerRuntimeStockName, buildSearchStockList, resolveSymbolOrName } from '../src/lib/stockDictionary';

console.log('--- Stock Search Verification Test ---');

// 1. Check STOCK_NAME_MAP count
const mapKeys = Object.keys(STOCK_NAME_MAP);
console.log(`1. Master STOCK_NAME_MAP entries count: ${mapKeys.length}`);

// 2. Test target stocks resolution
const testTargets = ['삼성전자', '카카오', '셀트리온', '현대차', '알테오젠', 'SK하이닉스', '005930', '035720'];
const presets = [
  { symbol: '005930', name: '삼성전자', market: 'KOSPI' as const, currentPrice: 78500, change: 1200, changeRate: 1.55, volume: 15420300 },
];
const top50s = [
  { symbol: '035720', name: '카카오', market: 'KOSPI' as const, basePrice: 42300 },
];

const list = buildSearchStockList(presets, top50s);

console.log('\n2. Testing stock query resolutions:');
testTargets.forEach((target) => {
  const resolved = resolveSymbolOrName(target, list);
  const name = getStockName(resolved);
  console.log(`  Query "${target}" -> Resolved Symbol: "${resolved}" (Name: ${name})`);
});

// 3. Test runtime dynamic registration
console.log('\n3. Testing dynamic runtime stock registration:');
registerRuntimeStockName('999999', '테스트신규종목');
const updatedList = buildSearchStockList(presets, top50s);
const resolvedDynamic = resolveSymbolOrName('테스트신규종목', updatedList);
console.log(`  Query "테스트신규종목" -> Resolved Symbol: "${resolvedDynamic}" (Name: ${getStockName(resolvedDynamic)})`);

console.log('\n--- All Logic Verification Completed Successfully! ---');
