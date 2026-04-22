/**
 * okx-wallet-browser.ts
 *
 * Launch Chromium with OKX Wallet extension using a pre-authenticated Chrome profile.
 * This allows the bot to interact with OKX Web3 wallet for on-chain operations.
 *
 * Usage:
 *   npx tsx src/okx-wallet-browser.ts [--headless] [--url <url>]
 *
 * Options:
 *   --headless   Run headless (no visible window). Default: headed.
 *   --url        URL to open after launch. Default: https://web3.okx.com/portfolio
 */

import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type BrowserContext } from "@playwright/test";
import { writeAnodosSessionStatus } from "./anodos-session-bridge.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OKX_EXTENSION_ID = "mcohilncbfahbmgdjkbpemcciiolgcge";

// System Chrome profile (pre-authenticated)
const SYSTEM_CHROME_PROFILE = path.resolve(
  process.env.HOME ?? "/root",
  ".config/google-chrome"
);

// Project-local copy of the Chrome profile for Playwright
const LOCAL_PROFILE = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../data/google-oauth-profile"
);

// OKX extension path from system Chrome
const OKX_EXTENSION_PATH = path.join(
  SYSTEM_CHROME_PROFILE,
  "Default/Extensions",
  OKX_EXTENSION_ID,
  "3.99.0_0"
);

// Fallback: local copy if system path unavailable
const OKX_EXTENSION_LOCAL = path.join(
  LOCAL_PROFILE,
  "Default/Extensions",
  OKX_EXTENSION_ID,
  "3.99.0_0"
);

function getArg(flag: string, fallback = ""): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function resolveExtensionPath(): Promise<string> {
  // Prefer system extension (up-to-date)
  try {
    await fs.access(path.join(OKX_EXTENSION_PATH, "manifest.json"));
    return OKX_EXTENSION_PATH;
  } catch {
    // Fallback to local copy
    try {
      await fs.access(path.join(OKX_EXTENSION_LOCAL, "manifest.json"));
      return OKX_EXTENSION_LOCAL;
    } catch {
      throw new Error(
        `OKX Wallet extension not found.\n` +
        `  Checked: ${OKX_EXTENSION_PATH}\n` +
        `  Checked: ${OKX_EXTENSION_LOCAL}\n` +
        `  Install OKX Wallet in Chrome first.`
      );
    }
  }
}

export async function launchOkxWalletBrowser(options?: {
  headless?: boolean;
  url?: string;
}): Promise<BrowserContext> {
  const headless = options?.headless ?? hasFlag("--headless");
  const url = options?.url ?? getArg("--url", "https://web3.okx.com/portfolio");

  const extensionPath = await resolveExtensionPath();

  console.log(`[okx-wallet] extension: ${extensionPath}`);
  console.log(`[okx-wallet] profile:   ${LOCAL_PROFILE}`);
  console.log(`[okx-wallet] headless:  ${headless}`);
  console.log(`[okx-wallet] url:       ${url}`);

  const chromiumPath = path.join(
    process.env.HOME ?? "/root",
    ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
  );

  // Check if Playwright Chromium exists, otherwise use system chrome
  let executablePath = chromiumPath;
  try {
    await fs.access(chromiumPath);
  } catch {
    executablePath = "/usr/bin/google-chrome-stable";
    try {
      await fs.access(executablePath);
    } catch {
      executablePath = "/usr/bin/chromium-browser";
    }
  }

  const context = await chromium.launchPersistentContext(LOCAL_PROFILE, {
    headless,
    executablePath,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  console.log("[okx-wallet] browser launched with OKX Wallet extension");

  // Navigate to target URL
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  console.log(`[okx-wallet] navigated to ${url}`);

  const monitorAnodos = /dex\.anodos\.finance/i.test(url);
  if (monitorAnodos) {
    const writeSnapshot = async () => {
      try {
        const html = await page.content();
        const state = await writeAnodosSessionStatus({
          source: page.url(),
          html,
          reachable: true,
        });
        console.log(
          `[okx-wallet] anodos-session status updated (blocked=${state.blocked}, xrplHint=${state.hasXrplHint})`
        );
      } catch (error) {
        console.warn(
          `[okx-wallet] failed to write anodos-session status: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    await writeSnapshot();
    const timer = setInterval(writeSnapshot, 20_000);
    timer.unref();
    context.on("close", () => clearInterval(timer));
  }

  return context;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("okx-wallet-browser.ts")) {
  (async () => {
    const context = await launchOkxWalletBrowser();

    console.log("[okx-wallet] browser ready. Press Ctrl+C to exit.");
    console.log("[okx-wallet] OKX Wallet popup: chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge/popup.html");

    // Keep alive
    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });

    await context.close();
    console.log("[okx-wallet] browser closed.");
  })().catch((err) => {
    console.error("[okx-wallet] fatal:", err.message);
    process.exit(1);
  });
}
