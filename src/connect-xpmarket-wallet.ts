// Fix TS error: Property 'ethereum' does not exist on type 'Window & typeof globalThis'.
declare global {
  interface Window {
    ethereum?: any;
  }
}
import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION_PATH = path.join(ROOT, "extensions/metamask");
const PROFILE_DIR = path.join(ROOT, "data/browser-profile");
// Use Playwright's Chrome for Testing — branded Google Chrome blocks --load-extension
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? path.join(
  process.env.HOME ?? "/home/lasbonai",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
);

const XP_WALLET_URL = "https://xpmarket.com/wallet";
const XP_LOGIN_URL = "https://xpmarket.com/login?redirectTo=%2Fwallet";
const METAMASK_PASSWORD = process.env.METAMASK_PASSWORD ?? "intelijen";
const METAMASK_SEED_PHRASE = process.env.METAMASK_SEED_PHRASE ?? "idea spy matrix motor mimic term surround upgrade mad cover forest gesture";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag) || process.argv.includes(`${flag}=true`);
}

function isHeadless(): boolean {
  if (hasFlag("--headless")) return true;
  const env = (process.env.HEADLESS ?? "").toLowerCase();
  return env === "1" || env === "true" || env === "yes";
}

function startSessionObserver(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>
): () => void {
  const lastUrl = new Map<Page, string>();
  let timer: NodeJS.Timeout | undefined;

  const scan = () => {
    for (const p of context.pages()) {
      const url = p.url();
      const prev = lastUrl.get(p);
      if (url && url !== prev) {
        lastUrl.set(p, url);
        console.log(`[observe] url -> ${url}`);
      }
    }
  };

  context.on("page", (p) => {
    console.log(`[observe] page-opened -> ${p.url() || "about:blank"}`);
  });

  timer = setInterval(scan, 1000);
  scan();

  return () => {
    if (timer) {
      clearInterval(timer);
    }
  };
}

function startMetaMaskAutoApprover(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const runTick = async () => {
    if (busy) return;
    busy = true;

    try {
      const popups = context.pages().filter((p) => {
        const u = p.url();
        return u.includes("notification") || u.includes("confirm-transaction");
      });

      for (const popup of popups) {
        await popup.bringToFront().catch(() => {});

        const unlockInput = popup.locator('input[type="password"]').first();
        const unlockBtn = popup.locator("button").filter({ hasText: /unlock/i }).first();
        if ((await unlockInput.count()) > 0 && (await unlockBtn.count()) > 0) {
          await unlockInput.fill(METAMASK_PASSWORD).catch(() => {});
          await unlockBtn.click().catch(() => {});
          continue;
        }

        const clicked =
          (await clickFirstVisible(popup, [/next/i, /continue/i, /connect/i])) ||
          (await clickFirstVisible(popup, [/approve/i, /confirm/i, /sign/i, /allow/i, /ok/i]));

        if (clicked) {
          console.log("[metamask] auto-approval click");
        }
      }
    } finally {
      busy = false;
    }
  };

  timer = setInterval(() => {
    void runTick();
  }, 1200);

  return () => {
    if (timer) {
      clearInterval(timer);
    }
  };
}

async function gotoWithRetry(page: Page, url: string): Promise<void> {
  const attempts: Array<"domcontentloaded" | "load"> = ["domcontentloaded", "load"];
  let lastError: unknown;

  for (const waitUntil of attempts) {
    try {
      await page.goto(url, { waitUntil, timeout: 45_000 });
      return;
    } catch (err) {
      lastError = err;
      await page.waitForTimeout(1200);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Navigation failed");
}

async function tryUnlockMetaMask(page: Page): Promise<boolean> {
  // If MetaMask lock screen appears, unlock it with known password.
  const pwd = page.locator('input[type="password"]').first();
  const unlock = page.locator("button").filter({ hasText: /unlock/i }).first();

  if ((await pwd.count()) > 0 && (await unlock.count()) > 0) {
    await pwd.fill(METAMASK_PASSWORD);
    await unlock.click();
    await page.waitForTimeout(800);
    return true;
  }

  return false;
}

async function clickFirstVisible(page: Page, texts: RegExp[]): Promise<boolean> {
  for (const text of texts) {
    const loc = page.locator("button, a").filter({ hasText: text }).first();
    if ((await loc.count()) > 0) {
      await loc.click({ timeout: 10_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function approveMetaMaskNotifications(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>
): Promise<number> {
  let approvals = 0;

  for (let i = 0; i < 8; i += 1) {
    const popup =
      context
        .pages()
        .find((p) => p.url().includes("notification") || p.url().includes("confirm-transaction")) ??
      (await context
        .waitForEvent("page", {
          predicate: (p) => p.url().includes("notification") || p.url().includes("confirm-transaction"),
          timeout: 4_000
        })
        .catch(() => undefined));

    if (!popup) {
      break;
    }

    await popup.bringToFront();
    await popup.waitForTimeout(600);

    const clicked =
      (await clickFirstVisible(popup, [/next/i, /continue/i, /connect/i])) ||
      (await clickFirstVisible(popup, [/approve/i, /confirm/i, /sign/i, /allow/i, /ok/i]));

    if (!clicked) {
      break;
    }

    approvals += 1;
    await popup.waitForTimeout(900);
  }

  return approvals;
}

async function performXpMarketLoginWithMetaMask(
  page: Page,
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>
): Promise<void> {
  await gotoWithRetry(page, XP_LOGIN_URL);
  await page.waitForTimeout(1400);

  await clickFirstVisible(page, [/^accept$/i, /accept all/i, /agree/i, /cookie/i]);
  await page.waitForTimeout(1000);

  // Diagnostic: dump visible buttons/links on login page
  const loginButtons = await page
    .locator("button, a, [role='button'], .btn, [class*='wallet'], [class*='login']")
    .allTextContents()
    .then((arr) => arr.map((v) => v.trim()).filter(Boolean));
  console.log("[xpmarket] login page elements:", loginButtons.slice(0, 20).join(" | "));

  // Step 2a: Click "Connect" button to open wallet modal
  const clickedConnect = await clickFirstVisible(page, [/^connect$/i, /connect wallet/i]);
  if (clickedConnect) {
    console.log("[xpmarket] clicked 'Connect' button");
    await page.waitForTimeout(2000);
  }

  // Step 2a2: Click "Other wallets" to expand wallet list
  const clickedOther = await clickFirstVisible(page, [/other wallets?/i]);
  if (clickedOther) {
    console.log("[xpmarket] clicked 'Other wallets'");
    await page.waitForTimeout(2000);
  }

  // Dump everything visible including images/icons alt text and aria labels
  const allVisibleText = await page.evaluate(() => {
    const els = document.querySelectorAll("button, a, [role='button'], li, img, svg, span, div, p, h1, h2, h3, h4, label, [aria-label]");
    const texts = new Set<string>();
    for (const el of Array.from(els).slice(0, 200)) {
      const t = (el as HTMLElement).innerText?.trim();
      if (t && t.length > 0 && t.length < 60) texts.add(t);
      const aria = el.getAttribute("aria-label");
      if (aria) texts.add(`[aria]${aria}`);
      const alt = (el as HTMLImageElement).alt;
      if (alt) texts.add(`[alt]${alt}`);
      const title = el.getAttribute("title");
      if (title) texts.add(`[title]${title}`);
    }
    return Array.from(texts);
  });
  console.log("[xpmarket] full page dump:", allVisibleText.slice(0, 50).join(" | "));

  // Step 2b: click MetaMask option
  let clickedMetaMask = await clickFirstVisible(page, [/metamask/i]);
  if (!clickedMetaMask) {
    await clickFirstVisible(page, [/other wallets?/i, /other wallet/i]);
    await page.waitForTimeout(900);
    clickedMetaMask = await clickFirstVisible(page, [/metamask/i]);
  }

  if (!clickedMetaMask) {
    console.log("[xpmarket] metamask button not visible on login page");
    return;
  }

  // Step 3: check terms checkbox
  const termsWithText = page.locator("label, div, span").filter({ hasText: /accept.*terms|privacy policy|disclaimer/i }).first();
  if ((await termsWithText.count()) > 0) {
    await termsWithText.click().catch(() => {});
  }

  const terms = page.locator('input[type="checkbox"]').first();
  if ((await terms.count()) > 0) {
    await terms.check({ force: true }).catch(() => {});
  }

  // Step 4: click Sign In
  await clickFirstVisible(page, [/sign in/i]);

  // Step 5: auto-approve in MetaMask
  const approvalCount = await approveMetaMaskNotifications(context);
  console.log(`[metamask] approval-clicks=${approvalCount}`);
}

async function importMetaMaskWallet(page: Page): Promise<void> {
  try {
    // Wait for onboarding page to fully render
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    console.log("[metamask] onboarding URL:", page.url());

    // Step 0: Welcome screen — accept terms checkbox first (MetaMask v12 disables import button until terms accepted)
    const termsCheckbox = page.locator('[data-testid="onboarding-terms-checkbox"]');
    if ((await termsCheckbox.count()) > 0) {
      await termsCheckbox.click();
      console.log("[metamask] accepted terms checkbox");
      await page.waitForTimeout(500);
    } else {
      // Fallback: try any checkbox on the welcome page
      const anyCheckbox = page.locator('.onboarding-welcome input[type="checkbox"], .check-box, [role="checkbox"]').first();
      if ((await anyCheckbox.count()) > 0) {
        await anyCheckbox.click();
        console.log("[metamask] accepted terms checkbox (fallback)");
        await page.waitForTimeout(500);
      }
    }

    // Step 1: Welcome screen — click "Import an existing wallet"
    // MetaMask v12 uses data-testid="onboarding-import-wallet"
    const importBtnByTestId = page.locator('[data-testid="onboarding-import-wallet"]');
    const importBtnByText = page.locator("button, a").filter({ hasText: /import.*wallet|import.*existing|i already have/i }).first();
    if ((await importBtnByTestId.count()) > 0) {
      await importBtnByTestId.click({ timeout: 10000 });
      console.log("[metamask] clicked 'Import an existing wallet' (data-testid)");
    } else if ((await importBtnByText.count()) > 0) {
      await importBtnByText.click({ timeout: 10000 });
      console.log("[metamask] clicked 'Import an existing wallet' (text match)");
    }
    await page.waitForTimeout(1500);

    // Step 2: Metametrics — "I agree" or "No thanks"
    // MetaMask v12 uses data-testid="metametrics-i-agree" / "metametrics-no-thanks"
    const agreeByTestId = page.locator('[data-testid="metametrics-i-agree"]');
    const noThanksById = page.locator('[data-testid="metametrics-no-thanks"]');
    const agreeByText = page.locator("button").filter({ hasText: /i agree|agree|no thanks/i }).first();
    if ((await noThanksById.count()) > 0) {
      await noThanksById.click();
      console.log("[metamask] clicked 'No thanks' for metametrics");
    } else if ((await agreeByTestId.count()) > 0) {
      await agreeByTestId.click();
      console.log("[metamask] clicked 'I agree' for metametrics");
    } else if ((await agreeByText.count()) > 0) {
      await agreeByText.click();
      console.log("[metamask] clicked metametrics button (text match)");
    }
    await page.waitForTimeout(1500);

    // Step 3: Enter seed phrase — MetaMask v12 uses individual input[data-testid="import-srp__srp-word-N"]
    // Note: there are also checkbox elements with data-testid="import-srp__srp-word-N-checkbox" — exclude those
    const words = METAMASK_SEED_PHRASE.split(/\s+/);
    const phraseInputs = page.locator('input[data-testid^="import-srp__srp-word"]:not([type="checkbox"])');
    const phraseCount = await phraseInputs.count();
    console.log("[metamask] seed phrase inputs found:", phraseCount);
    if (phraseCount >= 12) {
      for (let i = 0; i < Math.min(words.length, phraseCount); i++) {
        await phraseInputs.nth(i).fill(words[i]);
      }
      console.log("[metamask] filled", words.length, "seed words");
    } else {
      // Fallback: single textarea
      const textarea = page.locator("textarea, input[type='text']").first();
      if ((await textarea.count()) > 0) {
        await textarea.fill(METAMASK_SEED_PHRASE);
        console.log("[metamask] filled seed phrase via textarea fallback");
      }
    }
    await page.waitForTimeout(500);

    // Step 4: Confirm seed phrase — data-testid="import-srp-confirm"
    const confirmSrp = page.locator('[data-testid="import-srp-confirm"]');
    if ((await confirmSrp.count()) > 0) {
      await confirmSrp.click();
      console.log("[metamask] clicked confirm seed phrase");
    } else {
      await clickFirstVisible(page, [/confirm.*recovery|confirm.*phrase|next/i]);
    }
    await page.waitForTimeout(2000);

    // Step 5: Create password
    // MetaMask v12 uses data-testid="create-password-new" and "create-password-confirm"
    const newPwd = page.locator('[data-testid="create-password-new"]');
    const confirmPwd = page.locator('[data-testid="create-password-confirm"]');
    if ((await newPwd.count()) > 0) {
      await newPwd.fill(METAMASK_PASSWORD);
      await confirmPwd.fill(METAMASK_PASSWORD);
      console.log("[metamask] filled password fields (data-testid)");
    } else {
      const pwdInputs = page.locator('input[type="password"]');
      const pwdCount = await pwdInputs.count();
      if (pwdCount >= 2) {
        await pwdInputs.nth(0).fill(METAMASK_PASSWORD);
        await pwdInputs.nth(1).fill(METAMASK_PASSWORD);
      }
    }

    // Step 6: Accept terms checkbox — data-testid="create-password-terms"
    const termsCheck = page.locator('[data-testid="create-password-terms"]');
    if ((await termsCheck.count()) > 0) {
      await termsCheck.check({ force: true }).catch(() => {});
      console.log("[metamask] accepted terms checkbox");
    } else {
      const genericCheck = page.locator('input[type="checkbox"]').first();
      if ((await genericCheck.count()) > 0) {
        await genericCheck.check({ force: true }).catch(() => {});
      }
    }

    // Step 7: Click "Import my wallet" — data-testid="create-password-import"
    const importWalletBtn = page.locator('[data-testid="create-password-import"]');
    if ((await importWalletBtn.count()) > 0) {
      await importWalletBtn.click();
      console.log("[metamask] clicked 'Import my wallet'");
    } else {
      await clickFirstVisible(page, [/import.*wallet|import my|confirm/i]);
    }
    await page.waitForTimeout(4000);

    // Step 8: Completion screen — "Got it" — data-testid="onboarding-complete-done"
    const doneBtn = page.locator('[data-testid="onboarding-complete-done"]');
    if ((await doneBtn.count()) > 0) {
      await doneBtn.click();
      console.log("[metamask] clicked 'Got it' on completion screen");
    } else {
      await clickFirstVisible(page, [/got it|done|all done/i]);
    }
    await page.waitForTimeout(1500);

    // Step 9: Pin extension screen — "Next" then "Done"
    const pinNext = page.locator('[data-testid="pin-extension-next"]');
    if ((await pinNext.count()) > 0) {
      await pinNext.click();
      console.log("[metamask] clicked 'Next' on pin-extension");
      await page.waitForTimeout(1000);
    }
    const pinDone = page.locator('[data-testid="pin-extension-done"]');
    if ((await pinDone.count()) > 0) {
      await pinDone.click();
      console.log("[metamask] clicked 'Done' on pin-extension");
    } else {
      await clickFirstVisible(page, [/done|next/i]);
    }
    await page.waitForTimeout(1500);

    // Verify we reached the home screen
    const finalUrl = page.url();
    console.log("[metamask] final URL after onboarding:", finalUrl);
    if (finalUrl.includes("home.html") && !finalUrl.includes("onboarding")) {
      console.log("[metamask] wallet import completed successfully — at home screen");
    } else {
      console.log("[metamask] wallet import finished — URL:", finalUrl);
    }
  } catch (err) {
    console.log("[metamask] onboarding error:", (err as Error).message);
  }
}

async function ensureMetaMaskEnabled(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>): Promise<void> {
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
      let metamaskId = "";

      for (const item of Array.from(items)) {
        const root = (item as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (!root) continue;

        const nameEl = root.querySelector("#name");
        const name = (nameEl?.textContent ?? "").trim().toLowerCase();
        if (!name.includes("metamask")) continue;

        metamaskFound = true;
        metamaskId = (item as Element).getAttribute("id") ?? "";

        const enableToggle = root.querySelector("#enableToggle") as
          | (Element & { checked?: boolean; click: () => void })
          | null;

        if (enableToggle && !enableToggle.checked) {
          enableToggle.click();
        }

        metamaskEnabled = Boolean(enableToggle?.checked ?? true);
        break;
      }

      return { ok: true, developerMode, metamaskFound, metamaskEnabled, metamaskId };
    });

    if (!state.ok) {
      console.log(`[metamask] extensions page check skipped: ${state.reason}`);
      return;
    }

    console.log(
      `[metamask] developerMode=${state.developerMode} metamaskFound=${state.metamaskFound} metamaskEnabled=${state.metamaskEnabled}`
    );

    // Fallback: some Chrome builds require toggling from detail page.
    if (state.metamaskFound && !state.metamaskEnabled && state.metamaskId) {
      await page.goto(`chrome://extensions/?id=${state.metamaskId}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000
      });
      await page.waitForTimeout(1200);

      const detailState = await page.evaluate(() => {
        const manager = document.querySelector("extensions-manager");
        const detail = manager?.shadowRoot?.querySelector("extensions-detail-view");
        const root = detail?.shadowRoot;
        if (!root) {
          return { ok: false, enabled: false };
        }

        const toggle =
          (root.querySelector("#enableToggle") as (Element & { checked?: boolean; click: () => void }) | null) ??
          (root.querySelector("#enable-toggle") as (Element & { checked?: boolean; click: () => void }) | null) ??
          (root.querySelector('cr-toggle[id*="enable"]') as (Element & { checked?: boolean; click: () => void }) | null);

        if (!toggle) {
          return { ok: false, enabled: false };
        }

        if (!toggle.checked) {
          toggle.click();
        }

        return { ok: true, enabled: Boolean(toggle.checked ?? true) };
      });

      console.log(`[metamask] detail-toggle ok=${detailState.ok} enabled=${detailState.enabled}`);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const headless = isHeadless();
  const keepOpen = hasFlag("--keep-open");
  const observe = hasFlag("--observe") || keepOpen;

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
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(45_000);

    // --- DIAGNOSE: Pastikan MetaMask extension benar-benar ter-load ---
    // MV3 uses service workers; wait for it to appear
    let metamaskLoaded = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const sw = context.serviceWorkers();
      metamaskLoaded = sw.some(w => w.url().includes("chrome-extension"));
      if (metamaskLoaded) break;
      // Also listen for new service worker events
      await Promise.race([
        context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => null),
        new Promise(r => setTimeout(r, 2000)),
      ]);
    }
    console.log("[diagnose] MetaMask extension loaded:", metamaskLoaded);
    if (!metamaskLoaded) {
      console.error("[diagnose] MetaMask extension gagal ter-load di browser Playwright! Cek path EXTENSION_PATH dan pastikan folder extension valid.");
      await context.close();
      process.exit(2);
    }

    const stopObserver = observe ? startSessionObserver(context) : () => {};
    const stopAutoApprover = observe ? startMetaMaskAutoApprover(context) : () => {};

    // Handle MetaMask onboarding if this is a fresh profile — MUST complete before XPMarket
    // Wait a moment for MetaMask to open its onboarding tab
    await new Promise(r => setTimeout(r, 3000));
    let onboardingPage = context.pages().find((p) => {
      const u = p.url();
      return u.includes("onboarding") || u.includes("home.html");
    });
    if (!onboardingPage) {
      // Wait for MetaMask onboarding page to appear
      onboardingPage = await context.waitForEvent("page", {
        predicate: (p) => p.url().includes("home.html") || p.url().includes("onboarding"),
        timeout: 8000,
      }).catch(() => undefined);
    }
    if (onboardingPage && onboardingPage.url().includes("chrome-extension")) {
      console.log("[metamask] onboarding page detected, importing wallet...");
      await onboardingPage.bringToFront();
      await importMetaMaskWallet(onboardingPage);
      // Wait for MetaMask to finish setup
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log("[metamask] no onboarding needed (wallet already set up)");
    }

    await ensureMetaMaskEnabled(context);

    // Bring any MetaMask page front and unlock if needed.
    const maybeMm = context.pages().find((p) => p.url().includes("home.html"));
    if (maybeMm) {
      await maybeMm.bringToFront();
      await maybeMm.waitForTimeout(1000);
      const unlocked = await tryUnlockMetaMask(maybeMm);
      if (unlocked) {
        console.log("[metamask] unlocked");
      } else {
        console.log("[metamask] no unlock prompt (already unlocked or onboarding hidden)");
      }
    }

    // --- DIAGNOSE: Pastikan window.ethereum tersedia di halaman XPMarket ---
    const page = await context.newPage();
    await page.goto(XP_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);
    const hasEthereum = await page.evaluate(() => !!window.ethereum);
    console.log("[diagnose] window.ethereum detected:", hasEthereum);
    if (!hasEthereum) {
      console.error("[diagnose] window.ethereum tidak terdeteksi di halaman XPMarket! MetaMask tidak inject provider. Cek extension dan profile browser.");
      await context.close();
      process.exit(3);
    }

    // Lanjutkan flow normal
    await performXpMarketLoginWithMetaMask(page, context);

    // Always verify final wallet state from wallet page.
    await gotoWithRetry(page, XP_WALLET_URL);
    await page.waitForTimeout(1500);

    const currentUrl = page.url();
    const bodyText = await page
      .evaluate(() => document.body?.innerText ?? "")
      .then((v) => v.toLowerCase());

    const connectedByUrl = /\/wallet\/r[1-9a-z]{20,}/i.test(currentUrl);
    const connectedByUi =
      bodyText.includes("wallet balance") ||
      bodyText.includes("send") ||
      bodyText.includes("deposit") ||
      bodyText.includes("explore wallet");

    if (connectedByUrl || connectedByUi) {
      const addressMatch = currentUrl.match(/\/wallet\/(r[1-9a-z]{20,})/i);
      const address = addressMatch?.[1] ?? "unknown";
      console.log(`[xpmarket] connected=true address=${address}`);
      console.log(`[xpmarket] page=${currentUrl}`);

      if (keepOpen) {
        console.log("[observe] monitoring manual steps is active");
        console.log("[metamask] continuous auto-approval is active");
        console.log("[xpmarket] browser left open for manual continuation. Press Ctrl+C to stop.");
        await new Promise<void>((resolve) => {
          process.on("SIGINT", resolve);
          process.on("SIGTERM", resolve);
        });
      }
      stopAutoApprover();
      stopObserver();
      return;
    }

    // Gather wallet options rendered on page so we can assert support.
    const options = await page
      .locator("button, a, [role='button'], .wallet, .wallet-option")
      .allTextContents()
      .then((arr) => arr.map((v) => v.trim()).filter(Boolean));

    const normalized = options.join(" | ").toLowerCase();
    const hasMetaMask = normalized.includes("metamask");
    const hasWalletConnect = normalized.includes("walletconnect");
    const hasXaman = normalized.includes("xaman") || normalized.includes("xumm");
    const hasCrossmark = normalized.includes("crossmark");

    console.log(`[xpmarket] wallet options: metamask=${hasMetaMask}, walletconnect=${hasWalletConnect}, xaman=${hasXaman}, crossmark=${hasCrossmark}`);

    if (!hasMetaMask && hasWalletConnect) {
      // Try WalletConnect flow to demonstrate next step boundary.
      const opened = await clickFirstVisible(page, [/walletconnect/i]);
      if (opened) {
        await page.waitForTimeout(3000);
        console.log("[xpmarket] opened WalletConnect flow");
      }
    }

    // Keep browser open only if explicitly requested.
    if (!headless && keepOpen) {
      console.log("[observe] monitoring manual steps is active");
      console.log("[metamask] continuous auto-approval is active");
      console.log("[xpmarket] browser left open for manual continuation. Press Ctrl+C to stop.");
      await new Promise<void>((resolve) => {
        process.on("SIGINT", resolve);
        process.on("SIGTERM", resolve);
      });
    }
    stopAutoApprover();
    stopObserver();
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("[xpmarket-connect] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
