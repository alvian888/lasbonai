import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { collectWalletSnapshotWithContext } from "./check-xpmarket-wallet-tokens.js";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION_PATH = path.join(ROOT, "extensions/metamask");
const PROFILE_DIR = path.join(ROOT, "data/browser-profile");
const CHROMIUM_BIN = path.join(
  process.env.HOME ?? "/root",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
);

const TOP_URL = "https://xpmarket.com/tokens/top";
const MM_PASSWORD = process.env.METAMASK_PASSWORD ?? "intelijen";
const MM_SEED = process.env.METAMASK_SEED_PHRASE ?? "idea spy matrix motor mimic term surround upgrade mad cover forest gesture";
const DEFAULT_WALLET_URL = "https://xpmarket.com/login?redirectTo=%2Fwallet";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag) || process.argv.includes(`${flag}=true`);
}

function parseTokenKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function tokenKeyFromTokenUrl(tokenUrl: string): string {
  return tokenUrl.split("/token/")[1]?.split("?")[0] ?? "";
}

function tokenSymbolFromKey(tokenKey: string): string {
  return tokenKey.split("-")[0]?.trim().toUpperCase() ?? "";
}

async function clickFirst(page: Page, labels: RegExp[]): Promise<boolean> {
  for (const label of labels) {
    const loc = page.locator("button, a, [role='button']").filter({ hasText: label }).first();
    if ((await loc.count()) > 0) {
      await loc.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickFirstLoose(page: Page, labels: RegExp[]): Promise<boolean> {
  for (const label of labels) {
    const loc = page.locator("button, a, [role='button'], div, span").filter({ hasText: label }).first();
    if ((await loc.count()) > 0) {
      await loc.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function unlockMetaMaskIfNeeded(context: BrowserContext): Promise<void> {
  const mm = context.pages().find((p) => p.url().includes("home.html"));
  if (!mm) return;
  await mm.bringToFront();
  await mm.waitForTimeout(800);

  const pwd = mm.locator('input[type="password"]').first();
  const unlock = mm.locator("button").filter({ hasText: /unlock/i }).first();
  if ((await pwd.count()) > 0 && (await unlock.count()) > 0) {
    await pwd.fill(MM_PASSWORD);
    await unlock.click();
    await mm.waitForTimeout(1000);
    console.log("[metamask] unlocked");
  }
}

async function ensureMetaMaskEnabled(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1200);

    const state = await page.evaluate(() => {
      const manager = document.querySelector("extensions-manager");
      if (!manager || !manager.shadowRoot) {
        return { ok: false, reason: "extensions-manager-not-found" };
      }

      const toolbar = manager.shadowRoot.querySelector("extensions-toolbar");
      const devToggle = toolbar?.shadowRoot?.querySelector("#devMode");

      let developerMode = false;
      if (devToggle) {
        const toggle = devToggle as unknown as { checked?: boolean; click: () => void };
        if (!toggle.checked) {
          toggle.click();
        }
        developerMode = Boolean(toggle.checked ?? true);
      }

      const itemList = manager.shadowRoot.querySelector("extensions-item-list");
      const items = itemList?.shadowRoot?.querySelectorAll("extensions-item") ?? [];

      let metamaskFound = false;
      let metamaskEnabled = false;

      for (const item of Array.from(items)) {
        const root = (item as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (!root) continue;

        const nameEl = root.querySelector("#name");
        const name = (nameEl?.textContent ?? "").trim().toLowerCase();
        if (!name.includes("metamask")) continue;

        metamaskFound = true;

        const enableToggle = root.querySelector("#enableToggle") as
          | (Element & { checked?: boolean; click: () => void })
          | null;

        if (enableToggle && !enableToggle.checked) {
          enableToggle.click();
        }

        metamaskEnabled = Boolean(enableToggle?.checked ?? true);
        break;
      }

      return { ok: true, developerMode, metamaskFound, metamaskEnabled };
    });

    if (!state.ok) {
      console.log(`[metamask] extensions-check skipped: ${state.reason}`);
      return;
    }

    console.log(
      `[metamask] developerMode=${state.developerMode} metamaskFound=${state.metamaskFound} metamaskEnabled=${state.metamaskEnabled}`
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function hasMetaMaskProvider(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const ethereum = (window as unknown as { ethereum?: { isMetaMask?: boolean } }).ethereum;
      return Boolean(ethereum?.isMetaMask);
    })
    .catch(() => false);
}

async function ensureMetaMaskProviderOnLogin(page: Page): Promise<boolean> {
  await page.goto("https://xpmarket.com/login?redirectTo=%2Fwallet", {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(1400);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  let provider = await hasMetaMaskProvider(page);
  if (!provider) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1400);
    provider = await hasMetaMaskProvider(page);
  }

  console.log(`[metamask] provider-detected=${provider}`);
  return provider;
}

async function approveWalletPopups(context: BrowserContext): Promise<boolean> {
  let clickedAny = false;
  const actionLabels = [
    /next/i,
    /continue/i,
    /connect/i,
    /approve/i,
    /confirm/i,
    /sign/i,
    /ok/i,
    /allow/i,
    /submit/i,
    /accept/i
  ];

  for (let i = 0; i < 12; i += 1) {
    const popup = context.pages().find((p) => {
      const u = p.url();
      return (
        u.includes("notification") ||
        u.includes("popup") ||
        u.includes("chrome-extension://") ||
        u.includes("home.html")
      );
    });

    if (!popup) {
      const waited = await context
        .waitForEvent("page", {
          predicate: (p) => {
            const u = p.url();
            return (
              u.includes("notification") ||
              u.includes("popup") ||
              u.includes("chrome-extension://") ||
              u.includes("home.html")
            );
          },
          timeout: 3000
        })
        .catch(() => undefined);
      if (!waited) break;
    }

    const target = context.pages().find((p) => {
      const u = p.url();
      return (
        u.includes("notification") ||
        u.includes("popup") ||
        u.includes("chrome-extension://") ||
        u.includes("home.html")
      );
    });

    if (!target) break;

    await target.bringToFront();
    await target.waitForTimeout(500);

    const terms = target.locator('input[type="checkbox"]').first();
    if ((await terms.count()) > 0) {
      await terms.check().catch(() => {});
    }

    const clicked = await clickFirst(target, actionLabels);

    if (!clicked) {
      await target.waitForTimeout(800);
      continue;
    }

    clickedAny = true;
    await target.waitForTimeout(1000);
  }

  return clickedAny;
}

async function getTopTokenLinks(page: Page, limit: number): Promise<string[]> {
  await page.goto(TOP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  const links = await page.evaluate((max) => {
    const nodes = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/token/"]'));
    const hrefs = nodes
      .map((n) => n.href)
      .filter((v) => /\/token\//.test(v) && !/\/token\/XRP$/i.test(v));

    const unique: string[] = [];
    for (const h of hrefs) {
      if (!unique.includes(h)) unique.push(h);
      if (unique.length >= max) break;
    }

    return unique;
  }, limit);

  return links;
}

async function pageHasActionText(page: Page, action: "remove" | "set"): Promise<boolean> {
  const actionRegex = new RegExp(`\\b${action}\\b`, "i");

  const clickableCount = await page
    .locator("button, a, [role='button']")
    .filter({ hasText: actionRegex })
    .count()
    .catch(() => 0);

  if (clickableCount > 0) {
    return true;
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return actionRegex.test(bodyText);
}

type TrustlinePageStatus = {
  tokenKey: string;
  removeUrl: string;
  setUrl: string;
  hasRemoveText: boolean;
  hasSetText: boolean;
  status: "active" | "inactive" | "unknown";
};

async function detectTrustlinePageStatus(page: Page, tokenKey: string): Promise<TrustlinePageStatus> {
  const removeUrl = `https://xpmarket.com/trustline/${tokenKey}/remove`;
  const setUrl = `https://xpmarket.com/trustline/${tokenKey}/set`;

  await page.goto(removeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1200);
  await clickFirst(page, [/^accept$/i, /accept all/i]);
  const hasRemoveText = await pageHasActionText(page, "remove");

  if (hasRemoveText) {
    return {
      tokenKey,
      removeUrl,
      setUrl,
      hasRemoveText,
      hasSetText: false,
      status: "active"
    };
  }

  await page.goto(setUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1200);
  await clickFirst(page, [/^accept$/i, /accept all/i]);
  const hasSetText = await pageHasActionText(page, "set");

  return {
    tokenKey,
    removeUrl,
    setUrl,
    hasRemoveText,
    hasSetText,
    status: hasSetText ? "inactive" : "unknown"
  };
}

async function getHistoryTrustlineSetSymbols(page: Page, walletUrl: string): Promise<Set<string>> {
  const historyUrl = walletUrl.includes("?")
    ? `${walletUrl}&active=history`
    : `${walletUrl}?active=history`;

  await page.goto(historyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  const symbols = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'))
      .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const out: string[] = [];
    for (const row of rows) {
      if (!/trust\s*set|trustline\s*set/i.test(row)) {
        continue;
      }

      const symbolMatch = row.match(/Trustline\s*Set\s*([A-Za-z0-9]{2,12})/i);
      if (symbolMatch?.[1]) {
        const symbol = symbolMatch[1].toUpperCase();
        if (!out.includes(symbol)) {
          out.push(symbol);
        }
      }
    }
    return out;
  });

  return new Set(symbols);
}

async function resolveWalletUrlFromInput(page: Page, inputUrl: string): Promise<string> {
  await page.goto(inputUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  const byUrl = page.url();
  if (/^https:\/\/xpmarket\.com\/wallet\/r[1-9A-Za-z]{20,}/.test(byUrl)) {
    return byUrl;
  }

  const resolved = await resolveWalletUrlAfterTrustline(page);
  if (!resolved) {
    throw new Error(`Could not resolve wallet URL from input: ${inputUrl}`);
  }

  return resolved;
}

async function openLoginPageFirst(page: Page): Promise<void> {
  const loginUrl = "https://xpmarket.com/login?redirectTo=%2Fwallet";
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2000);
  await clickFirst(page, [/^accept$/i, /accept all/i]);
  console.log(`[trustline] step-1 login-page-opened=${loginUrl}`);
}

async function isConnectedOnXpMarket(page: Page): Promise<boolean> {
  const current = page.url();
  if (/^https:\/\/xpmarket\.com\/wallet\/r[1-9A-Za-z]{20,}/.test(current)) {
    return true;
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasConnectButton = /\bconnect\b/i.test(bodyText);
  const hasWalletAddress = /r[1-9A-Za-z]{20,}/.test(bodyText);
  return !hasConnectButton && hasWalletAddress;
}

async function ensureDisconnected(page: Page): Promise<boolean> {
  await page.goto("https://xpmarket.com/wallet", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  await clickFirstLoose(page, [/anonymous/i, /^r[A-Za-z0-9]{6,}/i, /account/i, /profile/i, /menu/i]);
  await page.waitForTimeout(800);

  const clickedLogout = await clickFirstLoose(page, [/log out/i, /logout/i, /disconnect/i]);
  await page.waitForTimeout(1200);

  await page.goto("https://xpmarket.com/login?redirectTo=%2Fwallet", {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(1500);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  const stillConnected = await isConnectedOnXpMarket(page);
  console.log(`[trustline] precheck logout-clicked=${clickedLogout}`);
  console.log(`[trustline] precheck disconnected=${!stillConnected}`);
  return !stillConnected;
}

async function importMetaMaskWallet(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    console.log("[metamask] onboarding URL:", page.url());

    // Step 0: Accept terms checkbox (required before import button becomes enabled)
    const termsCheckbox = page.locator('[data-testid="onboarding-terms-checkbox"]');
    if ((await termsCheckbox.count()) > 0) {
      await termsCheckbox.click();
      console.log("[metamask] accepted terms checkbox");
      await page.waitForTimeout(500);
    }

    // Step 1: Click "Import an existing wallet"
    const importBtn = page.locator('[data-testid="onboarding-import-wallet"]');
    if ((await importBtn.count()) > 0) {
      await importBtn.click({ timeout: 10000 });
      console.log("[metamask] clicked 'Import an existing wallet'");
    }
    await page.waitForTimeout(1500);

    // Step 2: Metametrics — "No thanks"
    const noThanks = page.locator('[data-testid="metametrics-no-thanks"]');
    if ((await noThanks.count()) > 0) {
      await noThanks.click();
      console.log("[metamask] clicked 'No thanks' for metametrics");
    }
    await page.waitForTimeout(1500);

    // Step 3: Enter seed phrase
    const words = MM_SEED.split(/\s+/);
    const phraseInputs = page.locator('input[data-testid^="import-srp__srp-word"]:not([type="checkbox"])');
    const phraseCount = await phraseInputs.count();
    if (phraseCount >= 12) {
      for (let i = 0; i < Math.min(words.length, phraseCount); i++) {
        await phraseInputs.nth(i).fill(words[i]);
      }
      console.log("[metamask] filled", words.length, "seed words");
    }
    await page.waitForTimeout(500);

    // Step 4: Confirm seed phrase
    const confirmSrp = page.locator('[data-testid="import-srp-confirm"]');
    if ((await confirmSrp.count()) > 0) {
      await confirmSrp.click();
      console.log("[metamask] clicked confirm seed phrase");
    }
    await page.waitForTimeout(2000);

    // Step 5: Create password
    const newPwd = page.locator('[data-testid="create-password-new"]');
    const confirmPwd = page.locator('[data-testid="create-password-confirm"]');
    if ((await newPwd.count()) > 0) {
      await newPwd.fill(MM_PASSWORD);
      await confirmPwd.fill(MM_PASSWORD);
      console.log("[metamask] filled password fields");
    }

    // Step 6: Accept terms
    const termsCheck = page.locator('[data-testid="create-password-terms"]');
    if ((await termsCheck.count()) > 0) {
      await termsCheck.check({ force: true }).catch(() => {});
      console.log("[metamask] accepted password terms");
    }

    // Step 7: Import wallet
    const importWalletBtn = page.locator('[data-testid="create-password-import"]');
    if ((await importWalletBtn.count()) > 0) {
      await importWalletBtn.click();
      console.log("[metamask] clicked 'Import my wallet'");
    }
    await page.waitForTimeout(4000);

    // Step 8: Completion — "Got it"
    const doneBtn = page.locator('[data-testid="onboarding-complete-done"]');
    if ((await doneBtn.count()) > 0) {
      await doneBtn.click();
      console.log("[metamask] clicked 'Got it'");
    }
    await page.waitForTimeout(1500);

    // Step 9: Pin extension
    const pinNext = page.locator('[data-testid="pin-extension-next"]');
    if ((await pinNext.count()) > 0) {
      await pinNext.click();
      await page.waitForTimeout(1000);
    }
    const pinDone = page.locator('[data-testid="pin-extension-done"]');
    if ((await pinDone.count()) > 0) {
      await pinDone.click();
    }
    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    if (finalUrl.includes("home.html") && !finalUrl.includes("onboarding")) {
      console.log("[metamask] wallet import completed — at home screen");
    } else {
      console.log("[metamask] wallet import finished — URL:", finalUrl);
    }
  } catch (err) {
    console.log("[metamask] onboarding error:", (err as Error).message);
  }
}

async function loginWithMetaMask(page: Page, context: BrowserContext): Promise<boolean> {
  await page.goto("https://xpmarket.com/login?redirectTo=%2Fwallet", {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(1500);
  await clickFirst(page, [/^accept$/i, /accept all/i, /agree/i, /cookie/i]);

  // XPMarket uses MetaMask Snaps — click "Connect" button (not a MetaMask-specific button)
  const clickedConnect = await clickFirst(page, [/^connect$/i, /connect wallet/i]);
  if (!clickedConnect) {
    console.log("[trustline] login connect-button-visible=false");
    return false;
  }
  console.log("[trustline] login clicked Connect button");

  // Approve MetaMask Snap popups (snaps-connect, snap-install, snap-install-result)
  await page.waitForTimeout(2000);
  const approved = await approveWalletPopups(context);
  console.log(`[trustline] login snap-approved=${approved}`);

  await page.waitForTimeout(3000);
  const walletUrl = await resolveWalletUrlAfterTrustline(page);
  const loginSuccess = Boolean(walletUrl);
  console.log(`[trustline] login connected=${loginSuccess}`);
  if (walletUrl) {
    console.log(`[trustline] login walletUrl=${walletUrl}`);
  }
  return loginSuccess;
}

async function runTrustlineFlow(page: Page, context: BrowserContext, tokenUrl: string): Promise<string> {
  const tokenKey = tokenKeyFromTokenUrl(tokenUrl);
  if (!tokenKey) {
    return "invalid-token-url";
  }

  const trustlineUrl = `https://xpmarket.com/trustline/${tokenKey}/set`;
  await page.goto(trustlineUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1800);
  await clickFirst(page, [/^accept$/i, /accept all/i]);

  const clicked = await clickFirst(page, [
    /^set$/i,
    /set trustline/i,
    /auto set trustline/i,
    /add trustline/i,
    /set trustline/i,
    /create trustline/i,
    /trustline/i,
    /trust line/i
  ]);

  if (!clicked) {
    return "no-trustline-button";
  }

  await page.waitForTimeout(1000);
  await clickFirst(page, [/confirm/i, /continue/i, /next/i, /submit/i, /approve/i]);

  let approved = await approveWalletPopups(context);
  if (!approved) {
    await page.waitForTimeout(2000);
    approved = await approveWalletPopups(context);
  }
  return approved ? "requested-and-approved" : "requested-awaiting-manual-approval";
}

async function resolveWalletUrlAfterTrustline(page: Page): Promise<string | null> {
  await page.goto("https://xpmarket.com/wallet", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);

  const byUrl = page.url();
  if (/^https:\/\/xpmarket\.com\/wallet\/r[1-9A-Za-z]{20,}/.test(byUrl)) {
    return byUrl;
  }

  const direct = await page
    .locator('a[href*="/wallet/r"]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  if (!direct) {
    return null;
  }

  if (direct.startsWith("http")) {
    return direct;
  }

  if (direct.startsWith("/")) {
    return `https://xpmarket.com${direct}`;
  }

  return null;
}

async function main(): Promise<void> {
  const limit = Number(process.env.TRUSTLINE_LIMIT ?? "10");
  const walletUrlInput = process.env.TRUSTLINE_WALLET_URL ?? DEFAULT_WALLET_URL;
  const explicitStatusCheckKeys = parseTokenKeys(
    process.env.TRUSTLINE_STATUS_CHECK_KEYS ??
      "RLUSD-rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De,REAL-rKVyXn1AhqMTvNA9hS6XkFjQNn2VE8Nz88"
  );
  const headless = hasFlag("--headless") || process.env.HEADLESS === "1";
  const keepOpen = hasFlag("--keep-open") || process.env.TRUSTLINE_KEEP_OPEN === "1";

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
    context.setDefaultTimeout(20_000);

    // Wait for MetaMask service worker (MV3)
    let metamaskLoaded = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const sw = context.serviceWorkers();
      metamaskLoaded = sw.some(w => w.url().includes("chrome-extension"));
      if (metamaskLoaded) break;
      await Promise.race([
        context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => null),
        new Promise(r => setTimeout(r, 2000)),
      ]);
    }
    console.log(`[trustline] metamask-loaded=${metamaskLoaded}`);
    if (!metamaskLoaded) {
      throw new Error("MetaMask extension failed to load");
    }

    // Handle MetaMask onboarding if fresh profile
    await new Promise(r => setTimeout(r, 3000));
    let onboardingPage = context.pages().find((p) => {
      const u = p.url();
      return u.includes("onboarding") || u.includes("home.html");
    });
    if (!onboardingPage) {
      onboardingPage = await context.waitForEvent("page", {
        predicate: (p) => p.url().includes("home.html") || p.url().includes("onboarding"),
        timeout: 8000,
      }).catch(() => undefined);
    }
    if (onboardingPage && onboardingPage.url().includes("chrome-extension")) {
      console.log("[trustline] onboarding detected — importing wallet...");
      await onboardingPage.bringToFront();
      await importMetaMaskWallet(onboardingPage);
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log("[trustline] no onboarding needed");
    }

    await ensureMetaMaskEnabled(context);
    await unlockMetaMaskIfNeeded(context);

    const page = await context.newPage();
    await openLoginPageFirst(page);
    await ensureMetaMaskProviderOnLogin(page);

    const connectedBefore = await isConnectedOnXpMarket(page);
    console.log(`[trustline] precheck connectedBefore=${connectedBefore}`);
    const disconnected = await ensureDisconnected(page);
    const loginDone = await loginWithMetaMask(page, context);
    console.log(`[trustline] precheck disconnectedVerified=${disconnected}`);
    console.log(`[trustline] precheck loginDone=${loginDone}`);

    const tokenLinks = await getTopTokenLinks(page, Number.isFinite(limit) && limit > 0 ? limit : 10);

    if (tokenLinks.length === 0) {
      throw new Error("No token links found from XPMarket top page");
    }

    console.log(`[trustline] tokens-found=${tokenLinks.length}`);

    const walletUrl = await resolveWalletUrlFromInput(page, walletUrlInput);
    const historySetSymbols = await getHistoryTrustlineSetSymbols(page, walletUrl);
    console.log(`[trustline] wallet-url input=${walletUrlInput}`);
    console.log(`[trustline] wallet-url resolved=${walletUrl}`);
    console.log(`[trustline] history-check url=${walletUrl}?active=history`);
    console.log(`[trustline] history-check trustlineSetSymbols=${historySetSymbols.size}`);
    if (historySetSymbols.size > 0) {
      console.log(`[trustline] history-check symbols=${Array.from(historySetSymbols).join(",")}`);
    }

    const results: Array<{
      tokenUrl: string;
      tokenKey: string;
      trustlineUrl: string;
      historyHint: string;
      beforeStatus: string;
      action: string;
      afterStatus: string;
    }> = [];

    for (const tokenUrl of tokenLinks.slice(0, 10)) {
      console.log(`[trustline] processing ${tokenUrl}`);

      const tokenKey = tokenKeyFromTokenUrl(tokenUrl);
      const symbol = tokenSymbolFromKey(tokenKey);
      const trustlineUrl = tokenKey
        ? `https://xpmarket.com/trustline/${tokenKey}/set`
        : "";

      if (!tokenKey) {
        results.push({
          tokenUrl,
          tokenKey,
          trustlineUrl,
          historyHint: "none",
          beforeStatus: "invalid-token-url",
          action: "skip",
          afterStatus: "invalid-token-url"
        });
        continue;
      }

      const historyHint = historySetSymbols.has(symbol) ? "seen-in-history" : "not-seen-in-history";

      let beforeStatus = "unknown";
      let afterStatus = "unknown";
      let action = "skip";

      try {
        const before = await detectTrustlinePageStatus(page, tokenKey);
        beforeStatus = before.status;

        if (before.status === "active") {
          action = "already-active-skip";
          afterStatus = "active";
        } else {
          const runStatus = await runTrustlineFlow(page, context, tokenUrl);
          action = `auto-set:${runStatus}`;
          const after = await detectTrustlinePageStatus(page, tokenKey);
          afterStatus = after.status;
        }
      } catch (err) {
        action = `error:${err instanceof Error ? err.message : "unknown"}`;
      }

      results.push({ tokenUrl, tokenKey, trustlineUrl, historyHint, beforeStatus, action, afterStatus });
      console.log(
        `[trustline] decision token=${tokenKey} history=${historyHint} before=${beforeStatus} action=${action} after=${afterStatus}`
      );
      await page.waitForTimeout(1200);
    }

    console.log("[trustline] summary");
    for (const row of results) {
      console.log(
        `- ${row.tokenKey} :: history=${row.historyHint} :: before=${row.beforeStatus} :: action=${row.action} :: after=${row.afterStatus} :: ${row.trustlineUrl}`
      );
    }

    const statusCheckSet = new Set<string>([
      ...results.map((row) => row.tokenKey).filter(Boolean),
      ...explicitStatusCheckKeys
    ]);

    console.log(`[trustline] status-check tokens=${statusCheckSet.size}`);
    for (const tokenKey of statusCheckSet) {
      try {
        const check = await detectTrustlinePageStatus(page, tokenKey);
        console.log(
          `[trustline] trustline-status token=${check.tokenKey} status=${check.status} removeText=${check.hasRemoveText} setText=${check.hasSetText}`
        );
        console.log(`[trustline] trustline-status removeUrl=${check.removeUrl}`);
        console.log(`[trustline] trustline-status setUrl=${check.setUrl}`);
      } catch (err) {
        console.log(
          `[trustline] trustline-status token=${tokenKey} status=error message=${err instanceof Error ? err.message : "unknown"}`
        );
      }
      await page.waitForTimeout(900);
    }

    const resolvedWalletUrl = await resolveWalletUrlAfterTrustline(page);
    if (!resolvedWalletUrl) {
      console.log("[trustline] wallet-verify skipped: wallet URL not detected");
      return;
    }

    const snapshot = await collectWalletSnapshotWithContext(context, resolvedWalletUrl);
    console.log(`[trustline] wallet-verify url=${resolvedWalletUrl}`);
    console.log(`[trustline] wallet-verify tokenLinks=${snapshot.tokenCountFromLinks}`);
    console.log(`[trustline] wallet-verify trustlineLinks=${snapshot.trustlineCountFromLinks}`);
    console.log(`[trustline] wallet-verify tokenRows=${snapshot.tokens.length}`);
    for (const token of snapshot.tokens.slice(0, 20)) {
      console.log(`[trustline] token ${token}`);
    }
    if (snapshot.trustlines.length > 0) {
      console.log(`[trustline] wallet-verify trustlineRows=${snapshot.trustlines.length}`);
      for (const row of snapshot.trustlines.slice(0, 20)) {
        console.log(`[trustline] trustline ${row}`);
      }
    }
  } finally {
    if (!keepOpen) {
      await context.close();
    } else {
      console.log("\n[trustline] Browser Chromium tetap terbuka untuk inspeksi manual. Tutup browser secara manual jika sudah selesai.\n");
      // Tunggu tanpa batas agar proses tidak exit
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
      }
    }
  }
}

main().catch((err) => {
  console.error("[trustline] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
