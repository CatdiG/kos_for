const puppeteer = require('puppeteer');

(async () => {
  try {
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,3200']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 3200 });
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Click '코스닥' button
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && text.trim() === '코스닥') {
        await btn.click();
        console.log('Clicked 코스닥 button');
        break;
      }
    }
    
    // Wait until table contains stock name (e.g. '파마리서치')
    console.log('Waiting for "파마리서치" row to appear in table...');
    await page.waitForFunction(() => {
      const tbody = document.querySelector('tbody');
      return tbody && tbody.textContent.includes('파마리서치') && !tbody.textContent.includes('로딩');
    }, { timeout: 30000 });
    
    await new Promise(r => setTimeout(r, 1000));
    
    const screenshotPath = 'C:\\Users\\LEE\\.gemini\\antigravity-ide\\brain\\7309b6a4-b7c8-42d3-b08c-1ccbb4e1e83d\\actual_kosdaq_screen.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('Kosdaq Screenshot saved to:', screenshotPath);
    await browser.close();
  } catch (err) {
    console.error('Error taking screenshot:', err);
    process.exit(1);
  }
})();
