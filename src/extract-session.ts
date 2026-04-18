/**
 * extract-session.ts
 *
 * Extracts browser cookies, localStorage, and MetaMask session state
 * from the Playwright persistent browser profile so that future automation
 * runs can reuse the session without going through onboarding + Snap connect.
 *
 * Usage:
 *   npx tsx src/extract-session.ts
 *   npx tsx src/extract-session.ts --profile data/browser-profile
 *   npx tsx src/extract-session.ts --output data/session-snapshot.json
 */
import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type BrowserContext } from "@playwright/test";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION_PATH = path.join(ROOT, "extensions/metamask");
const DEFAULT_PROFILE = path.join(ROOT, "data/browser-profile");
const DEFAULT_OUTPUT = path.join(ROOT, "data/session-snapshot.json");
const CHROMIUM_BIN = path.join(
  process.env.HOME ?? "/root",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
);

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

interface SessionSnapshot {
  extractedAt: string;
  profileDir: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  localStorage: Record<string, Record<string, string>>;
  metamaskState: {
    extensionId: string;
    hasIndexedDB: boolean;
    hasLocalExtSettings: boolean;
    walletUnlocked: boolean;
    currentUrl: string;
  };
  xpmarketState: {
    connected: boolean;
    walletAddress: string;
    walletUrl: string;
  };
}

async function extractLocalStorage(
  context: BrowserContext,
  origins: string[]
): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};

  for (const origin of origins) {
    const page = await context.newPage();
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const storage = await page.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) data[key] = localStorage.getItem(key) ?? "";
        }
        return data;
      }).catch(() => ({}));

      if (Object.keys(storage).length > 0) {
        result[origin] = storage;
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  return result;
}

async function checkMetaMaskState(context: BrowserContext): Promise<SessionSnapshot["metamaskState"]> {
  const extensionId = "glgjjjfhkgdpdmlgkooplgkajpebifpp";
  const mmPage = context.pages().find((p) => p.url().includes(extensionId));

  let walletUnlocked = false;
  let currentUrl = "";

  if (mmPage) {
    currentUrl = mmPage.url();
    walletUnlocked = !mmPage.url().includes("onboarding") && !mmPage.url().includes("unlock");
  } else {
    // Open MetaMask home to check state
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/home.html`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      }).catch(() => {});
      await page.waitForTimeout(2000);
      currentUrl = page.url();

      const hasUnlock = await page.locator('input[type="password"]').count().catch(() => 0);
      walletUnlocked = hasUnlock === 0 && !currentUrl.includes("onboarding");
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Check filesystem for IndexedDB and Local Extension Settings
  const profileDir = getArg("--profile", DEFAULT_PROFILE);
  const hasIndexedDB = await fs
    .access(path.join(profileDir, "Default/IndexedDB", `chrome-extension_${extensionId}_0.indexeddb.leveldb`))
    .then(() => true)
    .catch(() => false);
  const hasLocalExtSettings = await fs
    .access(path.join(profileDir, "Default/Local Extension Settings", extensionId))
    .then(() => true)
    .catch(() => false);

  return {
    extensionId,
    hasIndexedDB,
    hasLocalExtSettings,
    walletUnlocked,
    currentUrl,
  };
}

async function checkXpMarketState(context: BrowserContext): Promise<SessionSnapshot["xpmarketState"]> {
  const page = await context.newPage();
  try {
    await page.goto("https://xpmarket.com/wallet", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => {});
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    const walletMatch = currentUrl.match(/\/wallet\/(r[1-9A-Za-z]{20,})/);

    if (walletMatch) {
      return {
        connected: true,
        walletAddress: walletMatch[1],
        walletUrl: currentUrl,
      };
    }

    // Try to find wallet link on page
    const walletLink = await page
      .locator('a[href*="/wallet/r"]')
      .first()
      .getAttribute("href")
      .catch(() => null);

    if (walletLink) {
      const addr = walletLink.match(/\/wallet\/(r[1-9A-Za-z]{20,})/)?.[1] ?? "";
      return {
        connected: true,
        walletAddress: addr,
        walletUrl: walletLink.startsWith("http") ? walletLink : `https://xpmarket.com${walletLink}`,
      };
    }

    return { connected: false, walletAddress: "", walletUrl: "" };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const profileDir = getArg("--profile", DEFAULT_PROFILE);
  const outputPath = getArg("--output", DEFAULT_OUTPUT);

  await fs.access(profileDir);
  await fs.access(path.join(EXTENSION_PATH, "manifest.json"));
  await fs.access(CHROMIUM_BIN);

  console.log(`[session] extracting from profile: ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: CHROMIUM_BIN,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    viewport: { width: 1366, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  try {
    // Wait for MetaMask service worker
    for (let i = 0; i < 8; i++) {
      const sw = context.serviceWorkers();
      if (sw.some((w) => w.url().includes("chrome-extension"))) break;
      await Promise.race([
        context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => null),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }

    // 1. Extract cookies
    const cookies = await context.cookies();
    console.log(`[session] cookies extracted: ${cookies.length}`);

    // 2. Extract localStorage for key origins
    const localStorage = await extractLocalStorage(context, [
      "https://xpmarket.com",
    ]);
    const lsKeys = Object.values(localStorage).reduce((sum, obj) => sum + Object.keys(obj).length, 0);
    console.log(`[session] localStorage keys extracted: ${lsKeys}`);

    // 3. Check MetaMask state
    const metamaskState = await checkMetaMaskState(context);
    console.log(`[session] metamask unlocked=${metamaskState.walletUnlocked} indexedDB=${metamaskState.hasIndexedDB} extSettings=${metamaskState.hasLocalExtSettings}`);

    // 4. Check XPMarket connection
    const xpmarketState = await checkXpMarketState(context);
    console.log(`[session] xpmarket connected=${xpmarketState.connected} address=${xpmarketState.walletAddress}`);

    const snapshot: SessionSnapshot = {
      extractedAt: new Date().toISOString(),
      profileDir,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
      localStorage,
      metamaskState,
      xpmarketState,
    };

    await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");
    console.log(`[session] snapshot saved to: ${outputPath}`);

    // Also backup the browser profile directory list for reference
    const profileFiles = await fs.readdir(path.join(profileDir, "Default")).catch(() => []);
    console.log(`[session] profile files in Default/: ${profileFiles.length}`);

    console.log("\n[session] === SUMMARY ===");
    console.log(`  Cookies: ${cookies.length}`);
    console.log(`  localStorage origins: ${Object.keys(localStorage).length}`);
    console.log(`  MetaMask wallet: ${metamaskState.walletUnlocked ? "unlocked" : "locked/onboarding"}`);
    console.log(`  MetaMask IndexedDB: ${metamaskState.hasIndexedDB}`);
    console.log(`  XPMarket connected: ${xpmarketState.connected}`);
    console.log(`  XPMarket wallet: ${xpmarketState.walletAddress || "none"}`);
    console.log(`  Output: ${outputPath}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("[session] fatal:", (err as Error).message);
  process.exit(1);
});
