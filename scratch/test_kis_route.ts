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

async function runTest() {
  console.log('Testing fetchKisForeignInstitutionRanking for KOSDAQ...');
  try {
    const res = await fetchKisForeignInstitutionRanking('foreign', 'buy', '1d', 'KOSDAQ');
    console.log('isMock:', res.isMock, 'mockReason:', (res as any).mockReason);
    console.log('List length:', res.list ? res.list.length : 0);
    if (res.list && res.list.length > 0) {
      res.list.slice(0, 10).forEach((item, idx) => {
        console.log(`${idx + 1}위: ${item.name} (${item.symbol}) | 현재가: ${item.currentPrice} | netBuyQty: ${item.netBuyQty} | netBuyAmt: ${item.netBuyAmt} | netBuyAmtEok: ${item.netBuyAmtEok}억`);
      });
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

runTest();
