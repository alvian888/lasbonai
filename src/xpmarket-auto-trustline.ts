// xpmarket-auto-trustline.ts
// Otomasi: Ambil 10 top token XRPL dan auto-approve trustline
// Jalankan dengan: HEADLESS=0 npx tsx src/xpmarket-auto-trustline.ts --keep-open

import { chromium, BrowserContext } from 'playwright';

const XP_TOP10_URL = 'https://xpmarket.com/tokens?chain=XRPL&sort=volume_24h&order=desc';
const XP_WALLET_URL = 'https://xpmarket.com/wallet';
const PROFILE_PATH = process.env.TRUSTLINE_PROFILE_PATH || './data/google-oauth-profile';

async function getTop10Tokens(page: import('playwright').Page): Promise<Array<{symbol: string, link: string}>> {
  await page.goto(XP_TOP10_URL, { waitUntil: 'domcontentloaded' });
  // Coba selector utama, fallback ke selector alternatif jika gagal
  let rows = await page.$$('[data-testid="token-table-row"]');
  if (rows.length === 0) {
    rows = await page.$$('tbody tr'); // fallback
    if (rows.length === 0) {
      console.error('Token table row selector not found!');
      return [];
    }
  }
  const tokens = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];
    let symbol = '';
    let link = '';
    try {
      symbol = await row.$eval('[data-testid="token-symbol"]', (el: Element) => (el.textContent || '').trim());
    } catch {
      symbol = await row.$eval('td', (el: Element) => (el.textContent || '').trim());
    }
    try {
      link = await row.$eval('a', (el: HTMLAnchorElement) => el.href);
    } catch {
      link = '';
    }
    tokens.push({ symbol, link });
  }
  if (tokens.length === 0) {
    console.error('No tokens found on XPMarket!');
  }
  return tokens;
}

async function ensureTrustlineActive(page: import('playwright').Page, token: {symbol: string, link: string}): Promise<void> {
  await page.goto(token.link, { waitUntil: 'domcontentloaded' });
  try {
    // Tunggu tombol trustline muncul
    await page.waitForSelector('[data-testid="trustline-action"]', { timeout: 8000 });
    const status = await page.$eval('[data-testid="trustline-action"]', (el: Element) => (el.textContent || '').trim().toLowerCase());
    if (status.includes('add') || status.includes('enable') || status.includes('set') || status.includes('activate')) {
      console.log(`Trustline ${token.symbol} belum aktif, klik tombol untuk mengaktifkan...`);
      await page.click('[data-testid="trustline-action"]');
      // Tunggu popup MetaMask muncul (maks 20 detik)
      await page.waitForTimeout(20000);
      // Setelah popup, reload dan cek ulang status
      await page.reload({ waitUntil: 'domcontentloaded' });
      const newStatus = await page.$eval('[data-testid="trustline-action"]', (el: Element) => (el.textContent || '').trim().toLowerCase());
      if (!(newStatus.includes('remove') || newStatus.includes('active'))) {
        console.warn(`Trustline ${token.symbol} kemungkinan gagal diaktifkan, status: ${newStatus}`);
      } else {
        console.log(`Trustline ${token.symbol} sudah aktif.`);
      }
    } else {
      console.log(`Trustline ${token.symbol} sudah aktif.`);
    }
  } catch (e) {
    console.warn(`Trustline ${token.symbol}: tombol tidak ditemukan atau error: ${e}`);
  }
}

(async () => {
  const browser = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  });
  const page = await browser.newPage();
  await page.goto(XP_WALLET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const tokens = await getTop10Tokens(page);
  for (const token of tokens) {
    await ensureTrustlineActive(page, token);
  }
  console.log('Selesai: Semua trustline top 10 token XRPL sudah aktif atau dicek.');
  // Browser tetap terbuka
})();
