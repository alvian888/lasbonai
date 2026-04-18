import path from 'node:path';
import { chromium } from '@playwright/test';

const root = '/home/lasbonai/Desktop/lasbonai/okx-agentic-bot';
const ext = path.join(root, 'extensions/metamask');
const profile = path.join(root, 'data/browser-profile');
const bin = path.join(process.env.HOME ?? '/root', '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome');

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: bin,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ],
  ignoreDefaultArgs: ['--disable-extensions']
});

const p = await ctx.newPage();
for (const url of ['https://example.com', 'https://xpmarket.com/wallet', 'https://metamask.github.io/test-dapp/', 'https://snaps.metamask.io']) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(1200);
  const has = await p.evaluate(() => typeof window.ethereum !== 'undefined');
  console.log(url, 'ethereum=', has);
}

await ctx.close();
