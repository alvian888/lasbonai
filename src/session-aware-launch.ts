/**
 * session-aware-launch.ts
 *
 * Shared launch utility for all XPMarket automation scripts.
 * Detects whether MetaMask is already onboarded (persistent profile)
 * and whether XPMarket Snap is installed, then provides the fastest
 * path to a connected state:
 *
 * - If profile exists & MetaMask unlocked: skip onboarding entirely
 * - If Snap already installed: single "Connect" click (no multi-popup install)
 * - If fresh profile: full onboarding + Snap install
 *
 * Usage:
 *   import { launchConnectedSession, type ConnectedSession } from "./session-aware-launch.js";
 *   const session = await launchConnectedSession();
 *   // session.page is on xpmarket.com/wallet/{address}
 *   // session.context has MetaMask extension
 *   // session.walletAddress is the XRPL address
 *   // await session.close();
 */
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

const MM_PASSWORD = process.env.METAMASK_PASSWORD ?? "intelijen";
const MM_SEED =
  process.env.METAMASK_SEED_PHRASE ??
  "idea spy matrix motor mimic term surround upgrade mad cover forest gesture";

export interface ConnectedSession {
  context: BrowserContext;
  page: Page;
  walletAddress: string;
  walletUrl: string;
  sessionMode: "reused-profile" | "fresh-onboarding";
  close: () => Promise<void>;
}

// ─── Low-level helpers ──────────────────────────────────────────

async function clickFirst(page: Page, labels: RegExp[]): Promise<boolean> {
  for (const label of labels) {
    const loc = page
      .locator("button, a, [role='button']")
      .filter({ hasText: label })
      .first();
    if ((await loc.count()) > 0) {
      await loc.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function waitForMetaMask(context: BrowserContext): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (context.serviceWorkers().some((w) => w.url().includes("chrome-extension"))) {
      return true;
    }
    await Promise.race([
      context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => null),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
  return false;
}

async function unlockMetaMask(context: BrowserContext): Promise<boolean> {
  const mmPage = context.pages().find((p) => p.url().includes("home.html"));
  if (!mmPage) return false;

  const pwd = mmPage.locator('input[type="password"]').first();
  const unlock = mmPage.locator("button").filter({ hasText: /unlock/i }).first();
  if ((await pwd.count()) > 0 && (await unlock.count()) > 0) {
    await pwd.fill(MM_PASSWORD);
    await unlock.click();
    await mmPage.waitForTimeout(1000);
    console.log("[session] metamask unlocked");
    return true;
  }
  return false;
}

async function importMetaMaskWallet(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  // Step 0: Terms checkbox
  const terms = page.locator('[data-testid="onboarding-terms-checkbox"]');
  if ((await terms.count()) > 0) await terms.click();
  await page.waitForTimeout(500);

  // Step 1: Import wallet
  const importBtn = page.locator('[data-testid="onboarding-import-wallet"]');
  if ((await importBtn.count()) > 0) await importBtn.click({ timeout: 10000 });
  await page.waitForTimeout(1500);

  // Step 2: No thanks metametrics
  const noThanks = page.locator('[data-testid="metametrics-no-thanks"]');
  if ((await noThanks.count()) > 0) await noThanks.click();
  await page.waitForTimeout(1500);

  // Step 3: Seed phrase
  const words = MM_SEED.split(/\s+/);
  const inputs = page.locator('input[data-testid^="import-srp__srp-word"]:not([type="checkbox"])');
  const count = await inputs.count();
  if (count >= 12) {
    for (let i = 0; i < Math.min(words.length, count); i++) {
      await inputs.nth(i).fill(words[i]);
    }
  }
  await page.waitForTimeout(500);

  // Step 4: Confirm SRP
  const confirm = page.locator('[data-testid="import-srp-confirm"]');
  if ((await confirm.count()) > 0) await confirm.click();
  await page.waitForTimeout(2000);

  // Step 5: Password
  const newPwd = page.locator('[data-testid="create-password-new"]');
  const confirmPwd = page.locator('[data-testid="create-password-confirm"]');
  if ((await newPwd.count()) > 0) {
    await newPwd.fill(MM_PASSWORD);
    await confirmPwd.fill(MM_PASSWORD);
  }

  // Step 6: Terms
  const pwdTerms = page.locator('[data-testid="create-password-terms"]');
  if ((await pwdTerms.count()) > 0) await pwdTerms.check({ force: true }).catch(() => {});

  // Step 7: Import
  const importWallet = page.locator('[data-testid="create-password-import"]');
  if ((await importWallet.count()) > 0) await importWallet.click();
  await page.waitForTimeout(4000);

  // Step 8: Got it
  const done = page.locator('[data-testid="onboarding-complete-done"]');
  if ((await done.count()) > 0) await done.click();
  await page.waitForTimeout(1500);

  // Step 9: Pin extension
  const pinNext = page.locator('[data-testid="pin-extension-next"]');
  if ((await pinNext.count()) > 0) await pinNext.click();
  await page.waitForTimeout(1000);
  const pinDone = page.locator('[data-testid="pin-extension-done"]');
  if ((await pinDone.count()) > 0) await pinDone.click();
  await page.waitForTimeout(1500);

  console.log("[session] metamask onboarding completed");
}

async function approveSnapPopups(context: BrowserContext): Promise<boolean> {
  const actionLabels = [
    /next/i, /continue/i, /connect/i, /approve/i,
    /confirm/i, /sign/i, /ok/i, /allow/i, /submit/i, /accept/i,
  ];
  let approved = false;

  for (let i = 0; i < 12; i++) {
    let popup = context.pages().find((p) => {
      const u = p.url();
      return u.includes("notification") || u.includes("popup") || (u.includes("chrome-extension://") && u.includes("home.html"));
    });

    if (!popup) {
      popup = await context
        .waitForEvent("page", {
          predicate: (p) => p.url().includes("notification") || p.url().includes("popup"),
          timeout: 3000,
        })
        .catch(() => undefined);
    }
    if (!popup) break;

    await popup.bringToFront();
    await popup.waitForTimeout(500);

    // Check checkbox if present
    const cb = popup.locator('input[type="checkbox"]').first();
    if ((await cb.count()) > 0) await cb.check().catch(() => {});

    const clicked = await clickFirst(popup, actionLabels);
    if (!clicked) {
      await popup.waitForTimeout(800);
      continue;
    }
    approved = true;
    await popup.waitForTimeout(1000);
  }

  return approved;
}

async function connectXpMarketSnap(page: Page, context: BrowserContext): Promise<string | null> {
  await page.goto("https://xpmarket.com/login?redirectTo=%2Fwallet", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);
  await clickFirst(page, [/^accept$/i, /accept all/i, /agree/i, /cookie/i]);

  // Click "Connect" (XPMarket Snap flow)
  const clicked = await clickFirst(page, [/^connect$/i, /connect wallet/i]);
  if (!clicked) {
    console.log("[session] no Connect button found on login");
    return null;
  }
  console.log("[session] clicked Connect — approving Snap popups...");

  await page.waitForTimeout(2000);
  await approveSnapPopups(context);
  await page.waitForTimeout(3000);

  // Resolve wallet URL
  await page.goto("https://xpmarket.com/wallet", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2500);

  const url = page.url();
  const match = url.match(/\/wallet\/(r[1-9A-Za-z]{20,})/);
  if (match) return match[1];

  const link = await page
    .locator('a[href*="/wallet/r"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (link) {
    const addrMatch = link.match(/\/wallet\/(r[1-9A-Za-z]{20,})/);
    return addrMatch?.[1] ?? null;
  }

  return null;
}

// ─── Main export ────────────────────────────────────────────────

export async function launchConnectedSession(options?: {
  headless?: boolean;
  keepOpen?: boolean;
  profileDir?: string;
}): Promise<ConnectedSession> {
  const profileDir = options?.profileDir ?? PROFILE_DIR;
  const headless = options?.headless ?? false;

  await fs.access(path.join(EXTENSION_PATH, "manifest.json"));
  await fs.access(CHROMIUM_BIN);
  await fs.mkdir(profileDir, { recursive: true });

  // Detect if profile has MetaMask data (skip onboarding)
  const hasExistingProfile = await fs
    .access(path.join(profileDir, "Default/IndexedDB"))
    .then(() => true)
    .catch(() => false);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
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

  context.setDefaultTimeout(20_000);
  let sessionMode: "reused-profile" | "fresh-onboarding" = "reused-profile";

  // Wait for MetaMask service worker
  const mmLoaded = await waitForMetaMask(context);
  if (!mmLoaded) throw new Error("MetaMask extension failed to load");
  console.log("[session] metamask loaded");

  // Handle onboarding or unlock
  await new Promise((r) => setTimeout(r, 3000));

  if (hasExistingProfile) {
    console.log("[session] reusing existing profile — skipping onboarding");
    // Try unlock if needed
    await unlockMetaMask(context);
  } else {
    sessionMode = "fresh-onboarding";
    console.log("[session] fresh profile — running onboarding");

    let onboardingPage = context.pages().find((p) => {
      const u = p.url();
      return u.includes("onboarding") || u.includes("home.html");
    });
    if (!onboardingPage) {
      onboardingPage = await context
        .waitForEvent("page", {
          predicate: (p) => p.url().includes("home.html") || p.url().includes("onboarding"),
          timeout: 8000,
        })
        .catch(() => undefined);
    }
    if (onboardingPage?.url().includes("chrome-extension")) {
      await onboardingPage.bringToFront();
      await importMetaMaskWallet(onboardingPage);
    }
  }

  // Connect to XPMarket
  const page = await context.newPage();
  const walletAddress = await connectXpMarketSnap(page, context);

  if (!walletAddress) {
    await context.close();
    throw new Error("Failed to connect wallet on XPMarket");
  }

  const walletUrl = `https://xpmarket.com/wallet/${walletAddress}`;
  console.log(`[session] connected: ${walletAddress} (${sessionMode})`);

  return {
    context,
    page,
    walletAddress,
    walletUrl,
    sessionMode,
    close: () => context.close(),
  };
}
