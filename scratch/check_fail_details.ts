import path from 'path';
import fs from 'fs';

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

async function checkFailDetails() {
  const appKey = process.env.KIS_APPKEY!;
  const appSecret = process.env.KIS_APPSECRET!;
  const baseUrl = 'https://openapi.koreainvestment.com:9443';

  const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  const testSymbols = ['240810', '403870', '332570', '119850'];
  for (const sym of testSymbols) {
    // Try FID_COND_MRKT_DIV_CODE='J' vs 'Q'
    for (const mrkt of ['J', 'Q']) {
      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?FID_COND_MRKT_DIV_CODE=${mrkt}&FID_INPUT_ISCD=${sym}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010900',
          custtype: 'P',
        },
      });
      const json = await res.json();
      console.log(`Symbol: ${sym}, mrkt: ${mrkt} -> rt_cd: ${json.rt_cd}, msg1: ${json.msg1}, output.len: ${json.output?.length}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
}

checkFailDetails();
