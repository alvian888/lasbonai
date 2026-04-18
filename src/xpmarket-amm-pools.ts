/**
 * xpmarket-amm-pools.ts
 *
 * Automates AMM liquidity pool deposit on XPMarket.
 * Uses session-aware-launch for fast reconnect.
 *
 * Usage:
 *   npx tsx src/xpmarket-amm-pools.ts --pool XRP/RLUSD --amount 50
 *   npx tsx src/xpmarket-amm-pools.ts --list               # List available pools
 *   npx tsx src/xpmarket-amm-pools.ts --pool SOLO/XRP --amount 100 --keep-open
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
    pool: get("--pool"),               // e.g. "XRP/RLUSD"
    amount: get("--amount") ?? "10",
    action: args.includes("--withdraw") ? "withdraw" as const : "deposit" as const,
    listOnly: args.includes("--list"),
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

// ─── Pool Discovery ─────────────────────────────────────────────

interface PoolInfo {
  name: string;
  tokenA: string;
  tokenB: string;
  tvl: string;
  apy: string;
  url: string;
}

async function navigateToPoolsPage(page: Page): Promise<void> {
  const poolUrls = [
    "https://xpmarket.com/amm",
    "https://xpmarket.com/amm/pools",
    "https://xpmarket.com/liquidity",
    "https://xpmarket.com/pools",
  ];

  for (const url of poolUrls) {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    if (resp && resp.status() < 400) {
      console.log(`[amm] navigated to ${url}`);
      await page.waitForTimeout(2000);
      return;
    }
  }

  // Fallback: find AMM/liquidity link
  console.log("[amm] trying to find AMM link from main page...");
  await page.goto("https://xpmarket.com", { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForTimeout(2000);

  const ammLink = page.locator('a[href*="amm"], a[href*="liquidity"], a[href*="pool"]').first();
  if ((await ammLink.count()) > 0) {
    await ammLink.click();
    await page.waitForTimeout(2000);
    console.log(`[amm] navigated via link: ${page.url()}`);
  } else {
    throw new Error("[amm] could not find AMM/pools page — check XPMarket UI structure");
  }
}

async function listPools(page: Page): Promise<PoolInfo[]> {
  await navigateToPoolsPage(page);

  const pools: PoolInfo[] = [];

  // Try to get pool rows from table or card layout
  const rows = page.locator('table tbody tr, [class*="pool-row"], [class*="pool-card"], [class*="PoolItem"]');
  const count = await rows.count();

  if (count > 0) {
    for (let i = 0; i < Math.min(count, 20); i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => "");
      const link = await row.locator("a").first().getAttribute("href").catch(() => null);

      // Parse pool info from text (best-effort)
      const tokens = text?.match(/([A-Z]{2,10})\s*\/\s*([A-Z]{2,10})/);
      const tvl = text?.match(/TVL[:\s]*([\d,.]+[KMB]?)/i)?.[1] ?? "N/A";
      const apy = text?.match(/([\d.]+)\s*%/)?.[1] ?? "N/A";

      pools.push({
        name: tokens ? `${tokens[1]}/${tokens[2]}` : `pool-${i + 1}`,
        tokenA: tokens?.[1] ?? "?",
        tokenB: tokens?.[2] ?? "?",
        tvl,
        apy: apy !== "N/A" ? `${apy}%` : apy,
        url: link ? `https://xpmarket.com${link}` : page.url(),
      });
    }
  } else {
    // Fallback: grab any pool-like links
    const links = page.locator('a[href*="amm/"], a[href*="pool/"], a[href*="liquidity/"]');
    const linkCount = await links.count();
    for (let i = 0; i < Math.min(linkCount, 20); i++) {
      const href = await links.nth(i).getAttribute("href") ?? "";
      const text = await links.nth(i).textContent().catch(() => href);
      pools.push({
        name: text?.trim() ?? `pool-${i + 1}`,
        tokenA: "?",
        tokenB: "?",
        tvl: "N/A",
        apy: "N/A",
        url: `https://xpmarket.com${href}`,
      });
    }
  }

  return pools;
}

// ─── Deposit Flow ───────────────────────────────────────────────

async function depositToPool(
  page: Page,
  context: BrowserContext,
  opts: ReturnType<typeof parseArgs>
): Promise<{ success: boolean; txUrl?: string }> {
  if (!opts.pool) {
    throw new Error("[amm] --pool required (e.g. --pool XRP/RLUSD)");
  }

  const [tokenA, tokenB] = opts.pool.split("/");
  console.log(`[amm] ${opts.action}: ${opts.pool}, amount: ${opts.amount}`);

  await navigateToPoolsPage(page);

  // Find and click pool
  const poolLink = page.locator(`a:has-text("${tokenA}"), a:has-text("${opts.pool}")`).first();
  if ((await poolLink.count()) > 0) {
    await poolLink.click();
    await page.waitForTimeout(2000);
    console.log(`[amm] opened pool: ${page.url()}`);
  } else {
    // Try searching
    const search = page.locator('input[placeholder*="Search"], input[type="search"]').first();
    if ((await search.count()) > 0) {
      await search.fill(tokenA || "");
      await page.waitForTimeout(1500);
      const result = page.locator(`text=${tokenA}`).first();
      if ((await result.count()) > 0) {
        await result.click();
        await page.waitForTimeout(2000);
      }
    }
  }

  // Click deposit/add liquidity
  const actionClicked = opts.action === "deposit"
    ? await clickFirst(page, [/deposit/i, /add liquidity/i, /add/i, /provide/i])
    : await clickFirst(page, [/withdraw/i, /remove liquidity/i, /remove/i]);

  if (!actionClicked) {
    console.log(`[amm] WARNING: could not find ${opts.action} button`);
  }
  await page.waitForTimeout(1000);

  // Enter amount
  const amountInput = page.locator(
    'input[data-testid*="amount"], input[placeholder*="amount"], input[placeholder*="Amount"], input[type="number"]'
  ).first();
  if ((await amountInput.count()) > 0) {
    await amountInput.fill(opts.amount);
    await page.waitForTimeout(1000);
    console.log(`[amm] entered amount: ${opts.amount}`);
  }

  if (opts.dryRun) {
    console.log("[amm] DRY RUN — skipping execution");
    return { success: false };
  }

  // Confirm
  const confirmClicked = await clickFirst(page, [
    /confirm/i, /submit/i, /deposit/i, /add liquidity/i, /approve/i,
  ]);
  if (!confirmClicked) {
    console.log("[amm] could not find confirm button");
    return { success: false };
  }
  console.log("[amm] clicked confirm — approving wallet popup...");

  await page.waitForTimeout(2000);
  await approveWalletPopups(context);
  await page.waitForTimeout(5000);

  // Check result
  const successText = await page.locator('text=/success|confirmed|completed/i').first().textContent().catch(() => null);
  if (successText) {
    console.log(`[amm] result: ${successText.trim()}`);
    return { success: true, txUrl: page.url() };
  }

  const errorText = await page.locator('text=/error|failed|insufficient|rejected/i').first().textContent().catch(() => null);
  if (errorText) {
    console.log(`[amm] ERROR: ${errorText.trim()}`);
    return { success: false };
  }

  console.log("[amm] submitted — check wallet for confirmation");
  return { success: true, txUrl: page.url() };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  let session: ConnectedSession | null = null;
  try {
    session = await launchConnectedSession({ keepOpen: opts.keepOpen });
    console.log(`[amm] connected as ${session.walletAddress} (${session.sessionMode})`);

    if (opts.listOnly) {
      const pools = await listPools(session.page);
      console.log("\n═══════════════════════════════════════");
      console.log("  Available AMM Pools");
      console.log("═══════════════════════════════════════");
      if (pools.length === 0) {
        console.log("  No pools found — XPMarket AMM page may have changed");
      }
      for (const p of pools) {
        console.log(`  ${p.name.padEnd(15)} TVL: ${p.tvl.padEnd(10)} APY: ${p.apy}`);
      }
      console.log("═══════════════════════════════════════\n");
    } else {
      const result = await depositToPool(session.page, session.context, opts);

      console.log("\n═══════════════════════════════════════");
      console.log(`  AMM ${opts.action.toUpperCase()}: ${opts.pool}`);
      console.log(`  Amount: ${opts.amount}`);
      console.log(`  Result: ${result.success ? "✅ SUCCESS" : "❌ FAILED"}`);
      if (result.txUrl) console.log(`  TX: ${result.txUrl}`);
      console.log("═══════════════════════════════════════\n");
    }

    if (opts.keepOpen) {
      console.log("[amm] browser kept open — press Ctrl+C to close");
      await new Promise(() => {});
    }
  } catch (err) {
    console.error("[amm] fatal:", err);
    process.exitCode = 1;
  } finally {
    if (!opts.keepOpen && session) await session.close();
  }
}

main();
