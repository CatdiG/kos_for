const fs = require('fs');
const path = require('path');

// Read stockDictionary.ts content and extract STOCK_NAME_MAP keys to verify size
const dictContent = fs.readFileSync(path.join(__dirname, '../src/lib/stockDictionary.ts'), 'utf-8');

const matches = dictContent.match(/'\d{6}':\s*'[^']+'/g) || [];
console.log('--- Stock Dictionary Verification ---');
console.log(`1. Total master stock mapping entries in stockDictionary.ts: ${matches.length}`);

console.log('\n2. Verifying key target stock entries in dictionary:');
const targets = ['삼성전자', '카카오', '셀트리온', '현대차', '알테오젠', 'SK하이닉스', 'LG에너지솔루션', '기아'];

targets.forEach((name) => {
  const hasName = dictContent.includes(`'${name}'`);
  console.log(`  Target Stock "${name}": ${hasName ? 'EXISTS in stockDictionary' : 'MISSING'}`);
});

console.log('\n--- Verification Completed Successfully! ---');
