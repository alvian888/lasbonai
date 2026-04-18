/**
 * xpmarket-swap.ts
 *
 * Automates token swap on XPMarket DEX via MetaMask Snap.
 * Uses session-aware-launch for fast reconnect.
 *
 * Usage:
 *   npx tsx src/xpmarket-swap.ts --from XRP --to RLUSD --amount 10
 *   npx tsx src/xpmarket-swap.ts --from SOLO --to XRP --amount 100 --keep-open
 */

import { launchConnectedSession, type ConnectedSession } from "./session-aware-launch.js";
import type { Page, BrowserContext } from "@playwright/test";

// ─── CLI Args ───────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  return {
    fromToken: get("--from") ?? "XRP",
    toToken: get("--to") ?? "RLUSD",
    amount: get("--amount") ?? "1",
    slippage: get("--slippage") ?? "1",
    keepOpen: args.includes("--keep-open"),
    dryRun: args.includes("--dry-run"),
  };
}

// ─── Helpers ────────────────────────────────────────────────────

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

async function approveWalletPopups(context: BrowserContext): Promise<boolean> {
  const actionLabels = [
    /next/i, /continue/i, /connect/i, /approve/i,
    /confirm/i, /sign/i, /ok/i, /allow/i, /submit/i, /accept/i,
  ];
  let approved = false;

  for (let i = 0; i < 12; i++) {
    let popup = context.pages().find((p) => {
      const u = p.url();
      return u.includes("notification") || u.includes("popup") ||
        (u.includes("chrome-extension://") && u.includes("home.html"));
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

// ─── Swap Flow ──────────────────────────────────────────────────

async function navigateToSwap(page: Page): Promise<void> {
  // Try common XPMarket swap routes
  const swapUrls = [
    "https://xpmarket.com/swap",
    "https://xpmarket.com/trade",
    "https://xpmarket.com/dex",
  ];

  for (const url of swapUrls) {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    if (resp && resp.status() < 400) {
      console.log(`[swap] navigated to ${url}`);
      await page.waitForTimeout(2000);
      return;
    }
  }

  // Fallback: find swap link on page
  console.log("[swap] trying to find swap link from main page...");
  await page.goto("https://xpmarket.com", { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForTimeout(2000);

  const swapLink = page.locator('a[href*="swap"], a[href*="trade"], a[href*="dex"]').first();
  if ((await swapLink.count()) > 0) {
    await swapLink.click();
    await page.waitForTimeout(2000);
    console.log(`[swap] navigated via link: ${page.url()}`);
  } else {
    throw new Error("[swap] could not find swap page — check XPMarket UI structure");
  }
}

async function selectToken(page: Page, position: "from" | "to", tokenSymbol: string): Promise<void> {
  // Look for token selector buttons (commonly labeled with current token or "Select token")
  const selectors = position === "from"
    ? ['[data-testid="swap-from-token"]', '.swap-from button', 'button:has-text("From")', '.token-select:first-child']
    : ['[data-testid="swap-to-token"]', '.swap-to button', 'button:has-text("To")', '.token-select:last-child'];

  // Try data-testid first, then fallbacks
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) {
      await loc.click();
      await page.waitForTimeout(1000);
      break;
    }
  }

  // Search for token in modal/dropdown
  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]').first();
  if ((await searchInput.count()) > 0) {
    await searchInput.fill(tokenSymbol);
    await page.waitForTimeout(1500);

    // Click matching token in list
    const tokenOption = page.locator(`text=${tokenSymbol}`).first();
    if ((await tokenOption.count()) > 0) {
      await tokenOption.click();
      await page.waitForTimeout(500);
      console.log(`[swap] selected ${position} token: ${tokenSymbol}`);
      return;
    }
  }

  console.log(`[swap] WARNING: could not select ${position} token ${tokenSymbol} — manual inspection needed`);
}

async function executeSwap(
  page: Page,
  context: BrowserContext,
  opts: ReturnType<typeof parseArgs>
): Promise<{ success: boolean; txUrl?: string }> {
  await navigateToSwap(page);

  // Select tokens
  await selectToken(page, "from", opts.fromToken);
  await selectToken(page, "to", opts.toToken);

  // Enter amount
  const amountInput = page.locator(
    'input[data-testid="swap-amount"], input[placeholder*="amount"], input[placeholder*="Amount"], input[type="number"]'
  ).first();
  if ((await amountInput.count()) > 0) {
    await amountInput.fill(opts.amount);
    await page.waitForTimeout(1000);
    console.log(`[swap] entered amount: ${opts.amount} ${opts.fromToken}`);
  } else {
    console.log("[swap] WARNING: could not find amount input");
  }

  // Check for rate/price display
  await page.waitForTimeout(2000);
  const rateText = await page.locator('.rate, .price, .exchange-rate, [class*="rate"]').first().textContent().catch(() => null);
  if (rateText) console.log(`[swap] rate: ${rateText.trim()}`);

  if (opts.dryRun) {
    console.log("[swap] DRY RUN — skipping execution");
    return { success: false };
  }

  // Click swap button
  const swapClicked = await clickFirst(page, [/^swap$/i, /swap now/i, /exchange/i, /trade/i, /confirm swap/i]);
  if (!swapClicked) {
    console.log("[swap] could not find Swap button");
    return { success: false };
  }
  console.log("[swap] clicked Swap — approving wallet popup...");

  // Approve MetaMask popup
  await page.waitForTimeout(2000);
  const approved = await approveWalletPopups(context);
  if (!approved) {
    console.log("[swap] WARNING: no MetaMask popup detected — transaction may have failed");
  }

  // Wait for confirmation
  await page.waitForTimeout(5000);
  const currentUrl = page.url();
  console.log(`[swap] post-swap URL: ${currentUrl}`);

  // Check for success indicators
  const successText = await page.locator('text=/success|confirmed|completed|transaction/i').first().textContent().catch(() => null);
  if (successText) {
    console.log(`[swap] result: ${successText.trim()}`);
    return { success: true, txUrl: currentUrl };
  }

  // Check for error
  const errorText = await page.locator('text=/error|failed|insufficient|rejected/i').first().textContent().catch(() => null);
  if (errorText) {
    console.log(`[swap] ERROR: ${errorText.trim()}`);
    return { success: false };
  }

  console.log("[swap] swap submitted — check wallet for confirmation");
  return { success: true, txUrl: currentUrl };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`[swap] ${opts.fromToken} → ${opts.toToken}, amount: ${opts.amount}, slippage: ${opts.slippage}%`);
  if (opts.dryRun) console.log("[swap] DRY RUN mode");

  let session: ConnectedSession | null = null;
  try {
    session = await launchConnectedSession({ keepOpen: opts.keepOpen });
    console.log(`[swap] connected as ${session.walletAddress} (${session.sessionMode})`);

    const result = await executeSwap(session.page, session.context, opts);

    console.log("\n═══════════════════════════════════════");
    console.log(`  Swap: ${opts.fromToken} → ${opts.toToken}`);
    console.log(`  Amount: ${opts.amount}`);
    console.log(`  Result: ${result.success ? "✅ SUCCESS" : "❌ FAILED"}`);
    if (result.txUrl) console.log(`  TX: ${result.txUrl}`);
    console.log("═══════════════════════════════════════\n");

    if (opts.keepOpen) {
      console.log("[swap] browser kept open — press Ctrl+C to close");
      await new Promise(() => {}); // hang forever
    }
  } catch (err) {
    console.error("[swap] fatal:", err);
    process.exitCode = 1;
  } finally {
    if (!opts.keepOpen && session) await session.close();
  }
}

main();
