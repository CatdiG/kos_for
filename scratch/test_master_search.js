const fs = require('fs');
const path = require('path');
const http = require('http');

const cachePath = path.join(__dirname, '../src/lib/data/stockMasterCache.json');
const raw = fs.readFileSync(cachePath, 'utf-8');
const stocks = JSON.parse(raw);

console.log('=== KIS Master Stock Dataset Verification ===');
console.log(`Total Master Stocks Loaded: ${stocks.length}`);

const targetQueries = [
  '대원전선',
  '삼양사',
  '한온시스템',
  '경보제약',
  '메이슨캐피탈',
  '006340',
  '000230'
];

console.log('\n--- Resolving Target Stocks ---');
targetQueries.forEach((q) => {
  const match = stocks.find(
    (s) => s.name === q || s.symbol === q || s.name.includes(q)
  );
  if (match) {
    console.log(`✅ Query "${q}" -> Found: [${match.symbol}] ${match.name} (${match.market})`);
  } else {
    console.log(`❌ Query "${q}" -> NOT FOUND`);
  }
});

// Testing HTTP API Endpoint /api/stock/search?query=대원전선
console.log('\n--- Testing Next.js API Route (/api/stock/search) ---');
const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/stock/search?query=' + encodeURIComponent('대원전선'),
  method: 'GET',
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    console.log(`HTTP Status: ${res.statusCode}`);
    try {
      const json = JSON.parse(data);
      console.log('API Response:', JSON.stringify(json, null, 2));
    } catch (e) {
      console.log('API Raw Response:', data.slice(0, 300));
    }
  });
});

req.on('error', (e) => {
  console.log('HTTP request error:', e.message);
});

req.end();
