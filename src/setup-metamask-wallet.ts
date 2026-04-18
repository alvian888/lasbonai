/**
 * setup-metamask-wallet.ts
 *
 * Generate a new BIP-39 seed phrase, save it to secrets/metamask-wallet.json,
 * then launch Chromium + MetaMask and import the wallet automatically.
 *
 * Usage:
 *   npx tsx src/setup-metamask-wallet.ts
 *
 * Output:
 *   secrets/metamask-wallet.json  — seed phrase + address (DO NOT COMMIT)
 *   data/browser-profile/         — persistent MetaMask browser profile
 */

import path from "node:path";
import fs from "node:fs/promises";
import * as bip39 from "bip39";
import { chromium, type BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION_PATH = path.join(ROOT, "extensions/metamask");
const PROFILE_DIR = path.join(ROOT, "data/browser-profile");
const SECRETS_DIR = path.join(ROOT, "secrets");
const WALLET_FILE = path.join(SECRETS_DIR, "metamask-wallet.json");
const CHROMIUM_BIN = path.join(
  process.env.HOME ?? "/root",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
);

const PASSWORD = "intelijen";

// ---------------------------------------------------------------------------
// Seed phrase generation
// ---------------------------------------------------------------------------

async function generateOrLoadSeed(): Promise<string> {
  // If wallet file already exists, reuse existing seed
  try {
    const existing = JSON.parse(await fs.readFile(WALLET_FILE, "utf8")) as { seedPhrase?: string };
    if (existing.seedPhrase && bip39.validateMnemonic(existing.seedPhrase)) {
      console.log("[wallet] existing seed phrase loaded from secrets/metamask-wallet.json");
      return existing.seedPhrase;
    }
  } catch {
    // file doesn't exist yet — generate new
  }

  const mnemonic = bip39.generateMnemonic(128); // 12 words
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Generated mnemonic failed BIP-39 validation");
  }

  await fs.mkdir(SECRETS_DIR, { recursive: true });
  await fs.writeFile(
    WALLET_FILE,
    JSON.stringify({ seedPhrase: mnemonic, password: PASSWORD, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 } // owner read/write only
  );

  console.log("[wallet] new seed phrase generated and saved to secrets/metamask-wallet.json");
  return mnemonic;
}

// ---------------------------------------------------------------------------
// MetaMask onboarding automation
// ---------------------------------------------------------------------------

async function setupMetaMask(context: BrowserContext, seedPhrase: string): Promise<void> {
  console.log("[metamask] waiting for extension to load...");

  // Register event listener FIRST, then check existing pages, to avoid race condition
  const pagePromise = context.waitForEvent("page", {
    predicate: (p) => p.url().includes("home.html"),
    timeout: 40_000,
  });

  // MetaMask opens home.html on first launch — may already be open
  let mmPage = context.pages().find((p) => p.url().includes("home.html"));
  if (!mmPage) {
    // Also check for extension pages loading (url may be chrome-extension://.../home.html)
    mmPage = context.pages().find((p) => p.url().includes("home.html"));
    if (!mmPage) {
      mmPage = await pagePromise;
    }
  }

  await mmPage.bringToFront();
  // Wait until the page has settled (MetaMask needs a moment to inject JS)
  await mmPage.waitForLoadState("load");
  await mmPage.waitForTimeout(2_000);

  // ── Step 1: Accept terms ──────────────────────────────────────────────────
  console.log("[metamask] step 1/6: accepting terms...");
  try {
    const checkbox = mmPage.locator('input[type="checkbox"]').first();
    await checkbox.waitFor({ timeout: 10_000 });
    await checkbox.check();
    const agreeBtn = mmPage.locator('button').filter({ hasText: /agree/i }).first();
    await agreeBtn.click({ timeout: 8_000 });
  } catch {
    console.log("[metamask] terms step skipped (already accepted)");
  }

  // ── Step 2: Select "Import an existing wallet" ────────────────────────────
  console.log("[metamask] step 2/6: selecting import wallet...");
  try {
    const importBtn = mmPage.locator('button').filter({ hasText: /import.*wallet|existing/i }).first();
    await importBtn.click({ timeout: 10_000 });
  } catch {
    console.log("[metamask] import button not found — wallet may already be configured, exiting setup");
    return;
  }

  // ── Step 3: Decline metrics ───────────────────────────────────────────────
  console.log("[metamask] step 3/6: declining metrics...");
  try {
    const noBtn = mmPage.locator('button').filter({ hasText: /no thanks/i }).first();
    await noBtn.click({ timeout: 6_000 });
  } catch { /* optional step */ }

  // ── Step 4: Enter seed phrase ─────────────────────────────────────────────
  console.log("[metamask] step 4/6: entering seed phrase...");
  await mmPage.waitForTimeout(1_000);

  const words = seedPhrase.trim().split(/\s+/);

  // Try individual word inputs first (newer MetaMask UI)
  // Exclude the associated checkboxes (data-testid ends with "-checkbox")
  const wordInputs = mmPage.locator(
    '[data-testid^="import-srp__srp-word-"]:not([data-testid$="-checkbox"])'
  );
  const wordCount = await wordInputs.count().catch(() => 0);

  if (wordCount >= 12) {
    for (let i = 0; i < words.length; i++) {
      await wordInputs.nth(i).fill(words[i]);
    }
  } else {
    // Fallback: single textarea (older UI)
    const textarea = mmPage.locator("textarea").first();
    await textarea.fill(seedPhrase.trim());
  }

  const confirmSrpBtn = mmPage.locator('button').filter({ hasText: /confirm.*recovery|confirm.*phrase/i }).first();
  await confirmSrpBtn.click({ timeout: 10_000 });

  // ── Step 5: Set password ──────────────────────────────────────────────────
  console.log("[metamask] step 5/6: setting password...");
  await mmPage.waitForTimeout(1_000);

  const pwNew = mmPage.locator('[data-testid="create-password-new"], input[type="password"]').first();
  await pwNew.fill(PASSWORD);

  const pwConfirm = mmPage.locator('[data-testid="create-password-confirm"], input[type="password"]').nth(1);
  await pwConfirm.fill(PASSWORD);

  try {
    const pwTerms = mmPage.locator('[data-testid="create-password-terms"]');
    await pwTerms.check({ timeout: 4_000 });
  } catch { /* may not exist */ }

  const importWalletBtn = mmPage.locator('button').filter({ hasText: /import.*wallet/i }).first();
  await importWalletBtn.click({ timeout: 10_000 });

  // ── Step 6: Complete onboarding ───────────────────────────────────────────
  console.log("[metamask] step 6/6: completing onboarding...");
  for (const label of ["Got it", "Next", "Done"]) {
    try {
      await mmPage.locator('button').filter({ hasText: new RegExp(label, "i") }).first().click({ timeout: 15_000 });
      await mmPage.waitForTimeout(500);
    } catch { /* optional */ }
  }

  console.log("[metamask] wallet setup complete ✓");
  console.log(`[metamask] password: ${PASSWORD}`);
  console.log(`[metamask] seed phrase saved to: secrets/metamask-wallet.json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify extension
  await fs.access(path.join(EXTENSION_PATH, "manifest.json")).catch(() => {
    throw new Error(`MetaMask extension not found at ${EXTENSION_PATH}`);
  });

  // Verify Chromium binary
  await fs.access(CHROMIUM_BIN).catch(() => {
    throw new Error(`Chromium binary not found at ${CHROMIUM_BIN}\nRun: npx playwright install chromium`);
  });

  const seedPhrase = await generateOrLoadSeed();

  console.log("[browser] launching Chromium with MetaMask...");
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROMIUM_BIN,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  try {
    await setupMetaMask(context, seedPhrase);
  } finally {
    // Keep browser open briefly so user can see result, then close
    console.log("[browser] waiting 5s before closing...");
    await new Promise((r) => setTimeout(r, 5_000));
    await context.close();
    console.log("[browser] done");
  }
}

main().catch((err) => {
  console.error("[error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
