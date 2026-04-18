import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION_PATH = path.join(ROOT, "extensions/metamask");
const PROFILE_DIR = path.join(ROOT, "data/browser-profile");
const CHROMIUM_BIN = path.join(
  process.env.HOME ?? "/root",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
);

const XP_LOGIN_URL = "https://xpmarket.com/login?redirectTo=%2Fwallet";
const XP_WALLET_URL = "https://xpmarket.com/wallet";
const METAMASK_PASSWORD = process.env.METAMASK_PASSWORD ?? "intelijen";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag) || process.argv.includes(`${flag}=true`);
}

async function clickFirst(page: Page, patterns: RegExp[]): Promise<boolean> {
  for (const pattern of patterns) {
    const locator = page.locator("button, a, [role='button'], div, span").filter({ hasText: pattern }).first();
    if ((await locator.count()) > 0) {
      await locator.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function gotoWithRetry(page: Page, url: string): Promise<void> {
  const waits: Array<"domcontentloaded" | "load"> = ["domcontentloaded", "load"];
  let lastErr: unknown;
  for (const waitUntil of waits) {
    try {
      await page.goto(url, { waitUntil, timeout: 45_000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(800);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("navigation failed");
}

async function unlockMetaMaskIfNeeded(context: BrowserContext): Promise<void> {
  const mm = context.pages().find((p) => p.url().includes("home.html") || p.url().includes("notification"));
  if (!mm) return;

  await mm.bringToFront();
  const pwd = mm.locator('input[type="password"]').first();
  const unlock = mm.locator("button").filter({ hasText: /unlock/i }).first();
  if ((await pwd.count()) > 0 && (await unlock.count()) > 0) {
    await pwd.fill(METAMASK_PASSWORD).catch(() => {});
    await unlock.click().catch(() => {});
    await mm.waitForTimeout(1000);
    console.log("[metamask] unlocked");
  }
}

async function approveMetaMask(context: BrowserContext): Promise<number> {
  let clicks = 0;
  for (let i = 0; i < 8; i += 1) {
    const popup =
      context.pages().find((p) => p.url().includes("notification") || p.url().includes("confirm-transaction")) ??
      (await context
        .waitForEvent("page", {
          predicate: (p) => p.url().includes("notification") || p.url().includes("confirm-transaction"),
          timeout: 3_000
        })
        .catch(() => undefined));

    if (!popup) break;

    await popup.bringToFront();
    await popup.waitForTimeout(500);

    const clicked =
      (await clickFirst(popup, [/next/i, /continue/i, /connect/i])) ||
      (await clickFirst(popup, [/approve/i, /confirm/i, /sign/i, /allow/i, /ok/i]));

    if (!clicked) break;
    clicks += 1;
    await popup.waitForTimeout(900);
  }

  return clicks;
}

async function logoutXpMarket(page: Page): Promise<boolean> {
  await gotoWithRetry(page, XP_WALLET_URL);
  await page.waitForTimeout(1500);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  // Open account/menu first if needed.
  await clickFirst(page, [/anonymous/i, /^r[A-Za-z0-9]{6,}/i, /account/i, /profile/i, /menu/i]);
  await page.waitForTimeout(700);

  const didLogout = await clickFirst(page, [/log out/i, /logout/i, /disconnect/i]);
  await page.waitForTimeout(1200);

  return didLogout;
}

async function reconnectXpMarket(page: Page, context: BrowserContext): Promise<void> {
  await gotoWithRetry(page, XP_LOGIN_URL);
  await page.waitForTimeout(1200);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  let clickedMetamask = await clickFirst(page, [/metamask/i]);
  if (!clickedMetamask) {
    await clickFirst(page, [/other wallets?/i, /other wallet/i]);
    await page.waitForTimeout(700);
    clickedMetamask = await clickFirst(page, [/metamask/i]);
  }

  if (!clickedMetamask) {
    console.log("[xpmarket] metamask button not visible on login page");
    return;
  }

  const terms = page.locator('input[type="checkbox"]').first();
  if ((await terms.count()) > 0) {
    await terms.check({ force: true }).catch(() => {});
  }

  await clickFirst(page, [/sign in/i]);
  const approvals = await approveMetaMask(context);
  console.log(`[metamask] approval-clicks=${approvals}`);
}

async function main(): Promise<void> {
  const headless = hasFlag("--headless") || /^(1|true|yes)$/i.test(process.env.HEADLESS ?? "");
  const keepOpen = hasFlag("--keep-open");

  await fs.access(path.join(EXTENSION_PATH, "manifest.json"));
  await fs.access(CHROMIUM_BIN);
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    executablePath: CHROMIUM_BIN,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1366, height: 900 }
  });

  try {
    const page = await context.newPage();

    await unlockMetaMaskIfNeeded(context);

    const loggedOut = await logoutXpMarket(page);
    console.log(`[xpmarket] logout-attempt=${loggedOut}`);

    await reconnectXpMarket(page, context);

    await gotoWithRetry(page, XP_WALLET_URL);
    await page.waitForTimeout(1200);

    const finalUrl = page.url();
    const match = finalUrl.match(/\/wallet\/(r[1-9A-Za-z]{20,})/i);
    if (match) {
      console.log(`[xpmarket] reconnected=true address=${match[1]}`);
    } else {
      console.log("[xpmarket] reconnected=unknown");
    }
    console.log(`[xpmarket] finalPage=${finalUrl}`);

    if (keepOpen && !headless) {
      console.log("[xpmarket] browser left open. Press Ctrl+C to stop.");
      await new Promise<void>((resolve) => {
        process.on("SIGINT", resolve);
        process.on("SIGTERM", resolve);
      });
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("[xpmarket-reconnect] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
