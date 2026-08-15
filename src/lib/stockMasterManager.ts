import https from 'https';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { StockInfo } from './types';

export interface MasterStockEntry {
  symbol: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  stdCode?: string;
}

const CACHE_FILE_PATH = path.join(process.cwd(), 'src/lib/data/stockMasterCache.json');

/**
 * Pure Node.js ZIP buffer extractor for KIS master .zip files
 */
function unzipBuffer(buffer: Buffer): Buffer {
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
  throw new Error('No valid zip file entry found in buffer');
}

/**
 * Download helper with redirect handling
 */
function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download ${url}: HTTP status ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Parse KIS .mst fixed-width text data with EUC-KR / CP949 decoding
 */
function parseMstText(text: string, market: 'KOSPI' | 'KOSDAQ', fixedWidth: number): MasterStockEntry[] {
  const lines = text.split('\n');
  const stocks: MasterStockEntry[] = [];
  const symbolSet = new Set<string>();

  for (const line of lines) {
    if (!line || line.length <= fixedWidth) continue;

    const codeInfo = line.slice(0, -fixedWidth);
    let shortCode = codeInfo.slice(0, 9).trim();
    if (shortCode.startsWith('A')) shortCode = shortCode.slice(1);

    const stdCode = codeInfo.slice(9, 21).trim();
    const name = codeInfo.slice(21).trim();

    if (shortCode && name && /^\d{6}$/.test(shortCode) && !symbolSet.has(shortCode)) {
      symbolSet.add(shortCode);
      stocks.push({
        symbol: shortCode,
        name,
        market,
        stdCode,
      });
    }
  }

  return stocks;
}

let inMemoryMasterList: MasterStockEntry[] | null = null;

/**
 * Load master stock dataset from local cache JSON or fallback
 */
export function getMasterStockList(): MasterStockEntry[] {
  if (inMemoryMasterList && inMemoryMasterList.length > 0) {
    return inMemoryMasterList;
  }

  try {
    const filePath = path.join(process.cwd(), 'src', 'lib', 'data', 'stockMasterCache.json');
    if (fs.existsSync(filePath)) {
      const jsonText = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(jsonText);
      if (Array.isArray(data) && data.length > 0) {
        inMemoryMasterList = data as MasterStockEntry[];
        return inMemoryMasterList;
      }
    }
  } catch (err) {
    console.warn('[StockMaster] Local JSON cache read error:', err);
  }

  return [];
}

/**
 * Fetch fresh KIS KOSPI & KOSDAQ master files over HTTP and refresh local JSON cache
 */
export async function refreshStockMasterCache(): Promise<MasterStockEntry[]> {
  try {
    console.log('[StockMaster] Downloading KOSPI master file from KIS download server...');
    const kospiBuf = await downloadBuffer('https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip');
    const kospiRaw = unzipBuffer(kospiBuf);

    console.log('[StockMaster] Downloading KOSDAQ master file from KIS download server...');
    const kosdaqBuf = await downloadBuffer('https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip');
    const kosdaqRaw = unzipBuffer(kosdaqBuf);

    const decoder = new TextDecoder('euc-kr');
    const kospiText = decoder.decode(kospiRaw);
    const kosdaqText = decoder.decode(kosdaqRaw);

    const kospiStocks = parseMstText(kospiText, 'KOSPI', 228);
    const kosdaqStocks = parseMstText(kosdaqText, 'KOSDAQ', 222);

    const allStocks = [...kospiStocks, ...kosdaqStocks];

    if (allStocks.length > 0) {
      inMemoryMasterList = allStocks;
      const dir = path.dirname(CACHE_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(allStocks, null, 2), 'utf-8');
      console.log(`[StockMaster] Successfully updated stock master cache with ${allStocks.length} total listed stocks.`);
    }

    return allStocks;
  } catch (err) {
    console.error('[StockMaster] Failed to refresh master files:', err);
    return getMasterStockList();
  }
}
