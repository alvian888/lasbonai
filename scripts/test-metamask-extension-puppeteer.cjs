const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');

(async () => {
  const EXTENSION_PATH = path.resolve(__dirname, '../extensions/metamask');
  const PROFILE_DIR = path.resolve(__dirname, '../data/puppeteer-profile');
  // Use Playwright's Chrome for Testing — branded Google Chrome blocks --load-extension
  const CHROMIUM_BIN = path.join(
    os.homedir(),
    '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'
  );

  console.log('Using browser:', CHROMIUM_BIN);
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROMIUM_BIN,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]
  });

  // Wait for service worker to initialize (MV3)
  await new Promise(r => setTimeout(r, 6000));

  const targets = await browser.targets();
  // MV3: service_worker; MV2 fallback: background_page
  const extensionTarget = targets.find(t =>
    (t.type() === 'service_worker' || t.type() === 'background_page') &&
    t.url().includes('chrome-extension')
  );
  console.log('MetaMask extension loaded:', !!extensionTarget);
  if (extensionTarget) {
    console.log('Extension type:', extensionTarget.type(), 'URL:', extensionTarget.url());
  }

  // List all targets for debugging
  for (const t of targets) {
    console.log(`  target: type=${t.type()} url=${t.url()}`);
  }

  await new Promise(r => setTimeout(r, 3000));
  await browser.close();
})();
