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

// Inspect scratch/.kis_token_cache.json if present
const tokenFile = path.join(__dirname, '.kis_token_cache.json');
console.log('Token File Path:', tokenFile);
console.log('Token File Exists:', fs.existsSync(tokenFile));
if (fs.existsSync(tokenFile)) {
  console.log('Token File Contents:', fs.readFileSync(tokenFile, 'utf8'));
}
