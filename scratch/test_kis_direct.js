const fs = require('fs');

// Clear trendDetailCache in kisApi by clearing cache if any
let text = fs.readFileSync('src/lib/kisApi.ts', 'utf8');

// Let's test calling KIS API directly with node script loading kisApi
async function run() {
  const { fetchKisInvestorTrend } = require('./src/lib/kisApi');
}
