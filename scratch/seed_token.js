const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      process.env[key] = val;
    }
  });
}

const appKey = process.env.KIS_APPKEY.trim().replace(/^["']|["']$/g, '');
const appSecret = process.env.KIS_APPSECRET.trim().replace(/^["']|["']$/g, '');
const appKeyHash = `${appKey.slice(0, 6)}_real`;

async function seedToken() {
  console.log('Requesting initial KIS Token for disk cache seeding...');
  const res = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const data = await res.json();
  if (data.access_token) {
    const cache = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 86400) * 1000,
      app_key_hash: appKeyHash,
    };
    const tokenFile = path.join(__dirname, '.kis_token_cache.json');
    fs.writeFileSync(tokenFile, JSON.stringify(cache), 'utf8');
    console.log('Successfully seeded disk token cache file at:', tokenFile);
  } else {
    console.error('Seeding failed:', data);
  }
}

seedToken().catch(console.error);
