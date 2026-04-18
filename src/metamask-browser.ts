/**
 * metamask-browser.ts
 *
 * Launch Chromium with MetaMask extension loaded via Playwright.
 * Creates a persistent browser context so MetaMask state survives across runs.
 *
 * Usage:
 *   npx tsx src/metamask-browser.ts [--headless]
 *
 * Options:
 *   --headless   Run in headless mode (no visible window). Default: headed.
 *   --seed       BIP-39 seed phrase (12 words) for wallet import.
 *                Can also be set via METAMASK_SEED_PHRASE env var.
 *   --password   MetaMask unlock password (min 8 chars).
 *                Can also be set via METAMASK_PASSWORD env var.
 *   --profile    Path to persistent browser profile dir.
 *                Default: ./data/browser-profile
 */

import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(flag: string, fallback = ""): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getEnvOrArg(envKey: string, flag: string, fallback = ""): string {
  return process.env[envKey] ?? getArg(flag, fallback);
}

const EXTENSION_PATH = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../extensions/metamask"
);

const DEFAULT_PROFILE = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../data/browser-profile"
);

// ---------------------------------------------------------------------------
// MetaMask onboarding helpers
// ---------------------------------------------------------------------------

/** Wait for MetaMask onboarding page and complete wallet import. */
async function importWallet(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  seedPhrase: string,
  password: string
): Promise<void> {
  console.log("[metamask] waiting for onboarding page...");

  // MetaMask opens its onboarding tab automatically on first launch
  let onboardPage = context.pages().find((p) => p.url().includes("home.html"));
  if (!onboardPage) {
    onboardPage = await context.waitForEvent("page", {
      predicate: (p) => p.url().includes("home.html"),
      timeout: 30_000,
    });
  }

  await onboardPage.bringToFront();

  // Agree to terms
  try {
    const termsCheckbox = onboardPage.locator('input[type=checkbox]').first();
    await termsCheckbox.waitFor({ timeout: 10_000 });
    await termsCheckbox.check();
    await onboardPage.locator('button:has-text("I agree")').click();
  } catch {
    // terms may already be accepted if profile exists
  }

  // Select "Import wallet"
  try {
    await onboardPage.locator('button:has-text("Import an existing wallet")').click({ timeout: 10_000 });
  } catch {
    console.log("[metamask] import button not found — wallet may already be set up");
    return;
  }

  // Opt out of metrics
  try {
    await onboardPage.locator('button:has-text("No thanks")').click({ timeout: 5_000 });
  } catch { /* optional */ }

  // Enter seed phrase (12 words into individual inputs or single textarea)
  const words = seedPhrase.trim().split(/\s+/);
  const wordInputs = onboardPage.locator('[data-testid^="import-srp__srp-word-"]');
  const wordCount = await wordInputs.count().catch(() => 0);

  if (wordCount >= words.length) {
    for (let i = 0; i < words.length; i++) {
      await wordInputs.nth(i).fill(words[i]);
    }
  } else {
    // Single textarea fallback
    const textarea = onboardPage.locator('textarea').first();
    await textarea.fill(seedPhrase.trim());
  }

  await onboardPage.locator('button:has-text("Confirm Secret Recovery Phrase")').click({ timeout: 10_000 });

  // Set password
  await onboardPage.locator('[data-testid="create-password-new"]').fill(password);
  await onboardPage.locator('[data-testid="create-password-confirm"]').fill(password);
  await onboardPage.locator('[data-testid="create-password-terms"]').check();
  await onboardPage.locator('[data-testid="create-password-import"]').click();

  // Wait for completion
  await onboardPage.locator('button:has-text("Got it")').click({ timeout: 30_000 }).catch(() => {});
  await onboardPage.locator('button:has-text("Next")').click({ timeout: 10_000 }).catch(() => {});
  await onboardPage.locator('button:has-text("Done")').click({ timeout: 10_000 }).catch(() => {});

  console.log("[metamask] wallet import complete");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const headless = hasFlag("--headless");
  const seedPhrase = getEnvOrArg("METAMASK_SEED_PHRASE", "--seed");
  const password = getEnvOrArg("METAMASK_PASSWORD", "--password", "MetaMask@bot88");
  const profileDir = getArg("--profile", DEFAULT_PROFILE);

  await fs.mkdir(profileDir, { recursive: true });

  console.log(`[metamask] extension: ${EXTENSION_PATH}`);
  console.log(`[metamask] profile:   ${profileDir}`);
  console.log(`[metamask] headless:  ${headless}`);

  // Verify extension exists
  await fs.access(path.join(EXTENSION_PATH, "manifest.json")).catch(() => {
    throw new Error(
      `MetaMask extension not found at ${EXTENSION_PATH}.\nRun: npm run setup:metamask`
    );
  });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // MetaMask requires headed mode for initial setup; use --headless for later sessions only
    executablePath: path.join(
      process.env.HOME ?? "/root",
      ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
    ),
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      ...(headless ? ["--headless=new"] : []),
    ],
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  console.log("[metamask] browser launched");

  // Attempt wallet import if seed phrase provided
  if (seedPhrase) {
    await importWallet(context, seedPhrase, password);
  } else {
    console.log(
      "[metamask] no seed phrase provided — open MetaMask manually.\n" +
      "           Set METAMASK_SEED_PHRASE env var or pass --seed 'word1 word2 ...'"
    );
  }

  // Open a blank page to keep browser alive and show MetaMask popup
  const page = await context.newPage();
  await page.goto("about:blank");

  console.log("[metamask] browser ready. Press Ctrl+C to exit.");

  // Keep process alive until signal
  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });

  await context.close();
  console.log("[metamask] browser closed");
}

main().catch((err) => {
  console.error("[metamask] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
