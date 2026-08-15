const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.substring(0, idx).trim();
      const val = line.substring(idx + 1).trim();
      process.env[key] = val;
    }
  });
}

const appKey = process.env.KIS_APPKEY;
const appSecret = process.env.KIS_APPSECRET;

console.log('Testing AppKey:', appKey);

async function testServer(baseUrl, label) {
  console.log(`\n--- Testing ${label} (${baseUrl}) ---`);
  try {
    const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        appsecret: appSecret
      })
    });
    const json = await res.json();
    console.log('Token response:', json);
    if (json.access_token) {
      console.log(`SUCCESS! Access Token obtained from ${label}`);
      return { success: true, token: json.access_token, baseUrl };
    }
  } catch (e) {
    console.log(`Error connecting to ${label}:`, e.message);
  }
  return { success: false };
}

async function run() {
  // Test Real Server (openapi.koreainvestment.com:9443)
  const realRes = await testServer('https://openapi.koreainvestment.com:9443', 'Real Server (KIS_VIRTUAL=false)');
  
  // Test Virtual Server (openapivts.koreainvestment.com:29443)
  const vtsRes = await testServer('https://openapivts.koreainvestment.com:29443', 'Virtual Server (KIS_VIRTUAL=true)');
}

run();
