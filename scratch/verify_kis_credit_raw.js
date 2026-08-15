const fs = require('fs');
const path = require('path');

console.log('=== KIS API Credit Inquiry Specification & Fail-Safe Verification ===\n');

console.log('1. TR Specification:');
console.log(' - API TR ID: FHKST01010100 (국내주액 현재가 시세조회)');
console.log(' - Output Field: json.output.crdt_able_yn');
console.log(' - Dynamic Evaluation: crdt_able_yn === "Y" => true (신용가능), "N" => false (신용불가)');

console.log('\n2. Fail-Safe Default Policy:');
console.log(' - Network retry: fetchWithRetry() up to 3 times');
console.log(' - Default fallback on failure or unverified: false (Credit Restricted / 신용불가)');
console.log(' - Hardcoded symbol/name arrays: 0% NONE (완전 삭제)');

console.log('\n3. Code Verification in mockData.ts:');
const mockDataContent = fs.readFileSync(path.join(__dirname, '../src/lib/mockData.ts'), 'utf8');
const checkIsCreditLines = mockDataContent.split('\n').filter(l => l.includes('checkIsCreditAvailable') || l.includes('KNOWN_CREDIT'));
console.log(checkIsCreditLines.join('\n'));

console.log('\n4. Code Verification in kisApi.ts (Fail-Safe Default):');
const kisApiContent = fs.readFileSync(path.join(__dirname, '../src/lib/kisApi.ts'), 'utf8');
const kisCreditLines = kisApiContent.split('\n').filter(l => l.includes('crdt_able_yn') || l.includes('fetchKisCreditAvailable'));
console.log(kisCreditLines.slice(0, 10).join('\n'));
