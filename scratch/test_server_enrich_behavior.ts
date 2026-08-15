import path from 'path';
import fs from 'fs';
import { fetchKisForeignInstitutionRanking } from '../src/lib/kisApi';

const envPath = path.resolve(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      process.env[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
});

async function testServerEnrich() {
  console.log('Calling fetchKisForeignInstitutionRanking for KOSDAQ...');
  const res = await fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', 'KOSDAQ');
  console.log('isMock:', res.isMock);
  console.log('Total list length:', res.list ? res.list.length : 0);
  if (res.list) {
    res.list.forEach((item, idx) => {
      console.log(`${idx + 1}위: ${item.name} (${item.symbol}) | 현재가: ${item.currentPrice.toLocaleString()}원 | 수량: ${item.netBuyQty?.toLocaleString()}주 | 대금: ${item.netBuyAmt}백만원 (${item.netBuyAmtEok}억원)`);
    });
  }
}

testServerEnrich();
