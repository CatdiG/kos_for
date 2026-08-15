const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function unzipBuffer(buffer) {
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) === 0x04034b50) {
      const compression = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const fileNameLen = buffer.readUInt16LE(offset + 26);
      const extraLen = buffer.readUInt16LE(offset + 28);

      const dataStart = offset + 30 + fileNameLen + extraLen;
      const compressedData = buffer.slice(dataStart, dataStart + compressedSize);

      if (compression === 8) {
        return zlib.inflateRawSync(compressedData);
      } else if (compression === 0) {
        return compressedData;
      }
    }
    offset++;
  }
  throw new Error('No valid zip file entry found');
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: status ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function testMasterFetch() {
  console.log('Downloading KOSPI master file...');
  const kospiZipBuf = await downloadFile('https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip');
  const kospiRaw = unzipBuffer(kospiZipBuf);

  console.log('Downloading KOSDAQ master file...');
  const kosdaqZipBuf = await downloadFile('https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip');
  const kosdaqRaw = unzipBuffer(kosdaqZipBuf);

  const decoder = new TextDecoder('euc-kr');
  const kospiText = decoder.decode(kospiRaw);
  const kosdaqText = decoder.decode(kosdaqRaw);

  function parseMst(text, marketName, fixedWidth) {
    const lines = text.split('\n');
    const stocks = [];
    const symbolSet = new Set();
    for (const line of lines) {
      if (!line || line.length <= fixedWidth) continue;
      const codeInfo = line.slice(0, -fixedWidth);
      let shortCode = codeInfo.slice(0, 9).trim();
      if (shortCode.startsWith('A')) shortCode = shortCode.slice(1);
      const stdCode = codeInfo.slice(9, 21).trim();
      const name = codeInfo.slice(21).trim();

      if (shortCode && name && /^\d{6}$/.test(shortCode) && !symbolSet.has(shortCode)) {
        symbolSet.add(shortCode);
        stocks.push({ symbol: shortCode, name, market: marketName, stdCode });
      }
    }
    return stocks;
  }

  const kospiStocks = parseMst(kospiText, 'KOSPI', 228);
  const kosdaqStocks = parseMst(kosdaqText, 'KOSDAQ', 222);

  const allStocks = [...kospiStocks, ...kosdaqStocks];
  console.log(`Total Master Stocks: ${allStocks.length}`);

  const targetPath = path.join(__dirname, '../src/lib/data/stockMasterCache.json');
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(allStocks, null, 2), 'utf-8');
  console.log(`Saved master cache to ${targetPath}`);
}

testMasterFetch().catch(console.error);
