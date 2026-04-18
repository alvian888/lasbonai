import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

declare global {
  interface Window {
    ethereum?: any;
  }
}

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION_PATH = path.join(ROOT, "extensions/metamask");
const PROFILE_DIR = path.join(ROOT, "data/browser-profile");
const CHROMIUM_BIN = path.join(
  process.env.HOME ?? "/root",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
);
const REQUEST_ORIGIN = "https://example.com";

function getArg(flag: string, fallback = ""): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function clickFirst(page: Page, labels: RegExp[]): Promise<boolean> {
  for (const label of labels) {
    const btn = page.locator("button").filter({ hasText: label }).first();
    if ((await btn.count()) > 0) {
      await btn.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function waitForEthereum(page: Page, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hasProvider = await page
      .evaluate(() => typeof (window as Window & { ethereum?: unknown }).ethereum !== "undefined")
      .catch(() => false);
    if (hasProvider) return;
    await page.waitForTimeout(500);
  }
  throw new Error("MetaMask provider not injected within timeout");
}

async function unlockMetaMaskIfNeeded(context: BrowserContext, password: string): Promise<void> {
  const mmPage = context.pages().find((p) => p.url().includes("home.html"));
  if (!mmPage) return;

  await mmPage.bringToFront();
  await mmPage.waitForTimeout(800);

  const pwd = mmPage.locator('input[type="password"]').first();
  const unlockBtn = mmPage.locator("button").filter({ hasText: /unlock/i }).first();
  if ((await pwd.count()) > 0 && (await unlockBtn.count()) > 0) {
    await pwd.fill(password);
    await unlockBtn.click();
    await mmPage.waitForTimeout(1000);
    console.log("[metamask] unlocked");
  }
}

async function approveMetaMaskNotifications(context: BrowserContext): Promise<void> {
  // Approve up to 3 sequential confirmations (connect/install/permissions)
  for (let i = 0; i < 3; i += 1) {
    let notif: Page | undefined;

    // Already-open notification page
    notif = context
      .pages()
      .find((p) => p.url().includes("notification") || p.url().includes("confirm-transaction"));

    // Or wait for incoming notification popup
    if (!notif) {
      notif = await context
        .waitForEvent("page", {
          predicate: (p) => p.url().includes("notification") || p.url().includes("confirm-transaction"),
          timeout: 12_000
        })
        .catch(() => undefined);
    }

    if (!notif) return;

    await notif.bringToFront();
    await notif.waitForLoadState("domcontentloaded").catch(() => {});
    await notif.waitForTimeout(700);

    const clicked =
      (await clickFirst(notif, [/connect/i, /next/i, /continue/i])) ||
      (await clickFirst(notif, [/approve/i, /confirm/i, /ok/i, /install/i, /allow/i]));

    if (!clicked) {
      console.log("[metamask] notification shown but no known action button found");
      return;
    }

    await notif.waitForTimeout(1200);
  }
}

async function requestSnap(page: Page, snapId: string, version?: string): Promise<unknown> {
  const req = version ? { [snapId]: { version } } : { [snapId]: {} };

  return page.evaluate(async (snaps) => {
    const eth = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) throw new Error("window.ethereum is not available. MetaMask provider not injected.");

    return eth.request({
      method: "wallet_requestSnaps",
      params: [snaps]
    });
  }, req);
}

async function installFromSnapsUi(page: Page, snapId: string): Promise<void> {
  const detailUrl = `https://snaps.metamask.io/snap/${encodeURIComponent(snapId)}`;
  await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);

  await clickFirst(page, [/accept/i, /allow/i]);
  await clickFirst(page, [/connect/i, /install/i, /add to metamask/i, /try it/i]);
}

async function main(): Promise<void> {
  const snapId = getArg("--snap-id", "npm:xrpl-snap");
  const snapVersion = getArg("--snap-version", "1.0.3");
  const password = process.env.METAMASK_PASSWORD ?? getArg("--password", "intelijen");
  const headless = hasFlag("--headless");

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
    viewport: { width: 1366, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"]
  });

  try {
    await unlockMetaMaskIfNeeded(context, password);

    const page = await context.newPage();
    await page.goto(REQUEST_ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    await waitForEthereum(page, 30_000);

    let requestWorked = false;
    try {
      // Handle MetaMask confirmation popups in parallel while request is running.
      const approvals = approveMetaMaskNotifications(context);

      // Trigger request from provider-injected page context.
      const result = await requestSnap(page, snapId, snapVersion);
      await approvals;
      requestWorked = true;
      console.log("[snap] request result:", JSON.stringify(result));
    } catch (err) {
      // Some environments fail RPC request directly; fallback to Snap Store UI flow.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : JSON.stringify(err);
      console.log(`[snap] wallet_requestSnaps failed, fallback to UI flow: ${msg}`);

      await installFromSnapsUi(page, snapId);
      await approveMetaMaskNotifications(context);
    }

    await waitForEthereum(page, 30_000);
    const installed = await page.evaluate(async (id) => {
      const eth = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<Record<string, unknown>> } }).ethereum;
      if (!eth) return null;
      return eth.request({ method: "wallet_getSnaps" }).then((all: Record<string, any>) => all?.[id] ?? null);
    }, snapId);

    if (installed) {
      console.log(`[snap] installed: ${snapId}`);
      console.log("[snap] details:", JSON.stringify(installed));
    } else {
      if (requestWorked) {
        console.log("[snap] request flow ran but install still not visible in wallet_getSnaps");
      }
      console.log(`[snap] not detected in wallet_getSnaps for ${snapId}`);
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("[snap-setup] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
