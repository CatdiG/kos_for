const http = require('https');

async function testSave() {
  const url = 'https://kos-for.vercel.app/api/stock/quotes?symbols=005930';
  const res = await fetch(url);
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Data:', data);
}

testSave().catch(console.error);
