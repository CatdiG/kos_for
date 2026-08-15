const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      env[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
});

async function testTokenRequest() {
  const appKey = env.KIS_APPKEY;
  const appSecret = env.KIS_APPSECRET;
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

  console.log('Sending OAuth Token Request to:', `${baseUrl}/oauth2/tokenP`);
  
  const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret
    })
  });

  console.log('Response Status:', res.status, res.statusText);
  const json = await res.json();
  console.log('--- RAW OAUTH TOKEN RESPONSE JSON ---');
  console.log(JSON.stringify(json, null, 2));
}

testTokenRequest();
