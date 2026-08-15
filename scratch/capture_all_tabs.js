const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const artifactDir = 'C:\\Users\\LEE\\.gemini\\antigravity-ide\\brain\\836c1035-3075-4cec-a0c4-5fd731b05301';

if (!fs.existsSync(artifactDir)) {
  fs.mkdirSync(artifactDir, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.callbacks = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Use native global WebSocket
      const NativeWS = globalThis.WebSocket;
      this.ws = new NativeWS(this.wsUrl);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const res = JSON.parse(event.data);
        if (res.id && this.callbacks.has(res.id)) {
          const cb = this.callbacks.get(res.id);
          this.callbacks.delete(res.id);
          if (res.error) cb.reject(res.error);
          else cb.resolve(res.result);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result ? res.result.value : null;
  }

  async screenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Saved screenshot: ${outputPath} (${buffer.length} bytes)`);
  }
}

async function main() {
  const proc = spawn(edgePath, [
    '--headless',
    '--remote-debugging-port=9222',
    '--window-size=1280,1050',
    '--disable-gpu',
    'http://localhost:3000'
  ]);

  try {
    await sleep(3000);
    const targets = await getJson('http://127.0.0.1:9222/json/list');
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) throw new Error('Page target not found');

    const client = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await client.connect();

    await client.send('Page.enable');
    await client.send('DOM.enable');

    console.log('Connected to Edge CDP. Waiting for data rendering...');
    await sleep(4000);

    // 1. Foreigner Net Buy (외국인 순매수)
    console.log('Capturing: 1. 외국인 순매수 (Foreigner Buy)');
    await client.screenshot(path.join(artifactDir, 'foreigner_buy.png'));

    // 2. Foreigner Net Sell (외국인 순매도)
    console.log('Clicking: 순매도 button');
    await client.eval(`
      const btns = Array.from(document.querySelectorAll('button'));
      const sellBtn = btns.find(b => b.textContent.includes('순매도'));
      if (sellBtn) sellBtn.click();
    `);
    await sleep(2500);
    console.log('Capturing: 2. 외국인 순매도 (Foreigner Sell)');
    await client.screenshot(path.join(artifactDir, 'foreigner_sell.png'));

    // 3. Institution Net Buy (기관계 순매수)
    console.log('Clicking: 기관 tab & 순매수 button');
    await client.eval(`
      const btns = Array.from(document.querySelectorAll('button'));
      const organTab = btns.find(b => b.textContent.includes('기관') && !b.textContent.includes('외국인'));
      if (organTab) organTab.click();
      const buyBtn = btns.find(b => b.textContent.includes('순매수'));
      if (buyBtn) buyBtn.click();
    `);
    await sleep(2500);
    console.log('Capturing: 3. 기관계 순매수 (Institution Buy)');
    await client.screenshot(path.join(artifactDir, 'institution_buy.png'));

    // 4. Institution Net Sell (기관계 순매도)
    console.log('Clicking: 순매도 button for Institution');
    await client.eval(`
      const btns = Array.from(document.querySelectorAll('button'));
      const sellBtn = btns.find(b => b.textContent.includes('순매도'));
      if (sellBtn) sellBtn.click();
    `);
    await sleep(2500);
    console.log('Capturing: 4. 기관계 순매도 (Institution Sell)');
    await client.screenshot(path.join(artifactDir, 'institution_sell.png'));

    console.log('🎉 ALL 4 SCREENSHOTS CAPTURED SUCCESSFULLY!');
  } catch (err) {
    console.error('Error during capture:', err);
  } finally {
    proc.kill();
  }
}

main();
