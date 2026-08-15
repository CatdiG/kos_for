const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  try {
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,1200']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait an extra 3 seconds for client queries to populate
    await new Promise(r => setTimeout(r, 3000));
    
    const screenshotPath = 'C:\\Users\\LEE\\.gemini\\antigravity-ide\\brain\\7309b6a4-b7c8-42d3-b08c-1ccbb4e1e83d\\actual_screen.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('Screenshot saved to:', screenshotPath);
    await browser.close();
  } catch (err) {
    console.error('Error taking screenshot:', err);
    process.exit(1);
  }
})();
