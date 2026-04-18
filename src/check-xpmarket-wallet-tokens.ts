import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

type RootState = {
  activeTab?: {
    url?: string;
  };
};

export type WalletTokenSnapshot = {
  pageTitle: string;
  hasWalletBalance: boolean;
  hasTokensSection: boolean;
  tokenCountFromLinks: number;
  trustlineCountFromLinks: number;
  tokens: string[];
  trustlines: string[];
  snippet: string;
};

function getArg(flag: string, fallback = ""): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function resolveWalletUrl(): Promise<string> {
  const explicit = getArg("--wallet-url", "").trim();
  if (explicit) {
    return explicit;
  }

  const statePath = getArg("--state-file", "/home/lasbonai/Downloads/MetaMask state logs.json");
  const raw = await fs.readFile(path.resolve(statePath), "utf8");
  const state = JSON.parse(raw) as RootState;
  const url = state.activeTab?.url ?? "";

  if (!/^https:\/\/xpmarket\.com\/wallet\/r[1-9A-Za-z]{20,}/.test(url)) {
    throw new Error("Could not resolve XPMarket wallet URL from state log. Pass --wallet-url explicitly.");
  }

  return url;
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export async function extractWalletTokenSnapshot(page: Page): Promise<WalletTokenSnapshot> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText ?? "";
    const lines = bodyText
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const tokenAnchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/token/"]')
    );
    const trustlineAnchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/trustline/"]')
    );

    const tokenRows = tokenAnchors
      .map((anchor) => {
        const href = anchor.href || "";
        const tokenKey = href.split("/token/")[1]?.split("?")[0] ?? "";
        const rowContainer =
          anchor.closest("tr") ??
          anchor.closest('[role="row"]') ??
          anchor.closest("li") ??
          anchor.closest("article") ??
          anchor.parentElement;
        const rowText = (rowContainer?.textContent ?? anchor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          tokenKey,
          rowText,
          href
        };
      })
      .filter((row) => row.tokenKey)
      .filter((row) => row.rowText && !/^xrp$/i.test(row.tokenKey));

    const trustlineRows = trustlineAnchors
      .map((anchor) => {
        const href = anchor.href || "";
        const key = href.split("/trustline/")[1]?.split("/")[0] ?? "";
        const host =
          anchor.closest("tr") ??
          anchor.closest('[role="row"]') ??
          anchor.closest("li") ??
          anchor.closest("article") ??
          anchor.parentElement;
        const rowText = (host?.textContent ?? anchor.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        return { key, rowText, href };
      })
      .filter((row) => row.key);

    const uniqueTokens: string[] = [];
    for (const row of tokenRows) {
      const line = `${row.tokenKey} :: ${row.rowText}`.replace(/\s+/g, " ").trim();
      if (line && !uniqueTokens.includes(line)) {
        uniqueTokens.push(line);
      }
      if (uniqueTokens.length >= 50) break;
    }

    // XPMarket wallet often renders table-like data via divs with role=row.
    // This fallback captures visible row text even when token/trustline links are missing.
    if (uniqueTokens.length === 0) {
      const roleRows = Array.from(document.querySelectorAll('[role="row"]'))
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 0)
        .filter((text) => !/token holdings|price \/ 24h|portfolio %|community|actions/i.test(text));

      for (const text of roleRows) {
        if (/\$|%|\b[a-z0-9]{2,10}\b/i.test(text) && !uniqueTokens.includes(text)) {
          uniqueTokens.push(text);
        }
        if (uniqueTokens.length >= 50) break;
      }
    }

    // Last-resort fallback: extract lines around the TOKEN HOLDINGS block from visible text.
    if (uniqueTokens.length === 0) {
      const startIndex = lines.findIndex((line) => /token holdings/i.test(line));
      if (startIndex >= 0) {
        const endIndex = lines.findIndex((line, index) => index > startIndex && /xpmarket|copyright/i.test(line));
        const section = lines.slice(startIndex + 1, endIndex > startIndex ? endIndex : startIndex + 120);
        for (const line of section) {
          if (/hide zero balance|token|holdings|price \/ 24h|portfolio %|community|actions|rows|traders 24h/i.test(line)) {
            continue;
          }
          if (/\$|%|\b[a-z0-9]{2,10}\b/i.test(line) && !uniqueTokens.includes(line)) {
            uniqueTokens.push(line);
          }
          if (uniqueTokens.length >= 50) break;
        }
      }
    }

    const uniqueTrustlines: string[] = [];
    for (const row of trustlineRows) {
      const line = `${row.key} :: ${row.rowText}`.replace(/\s+/g, " ").trim();
      if (line && !uniqueTrustlines.includes(line)) {
        uniqueTrustlines.push(line);
      }
      if (uniqueTrustlines.length >= 50) break;
    }

    return {
      pageTitle: document.title,
      hasWalletBalance: /wallet balance/i.test(bodyText),
      hasTokensSection: /token holdings|tokens/i.test(bodyText),
      tokenCountFromLinks: tokenRows.length,
      trustlineCountFromLinks: trustlineRows.length,
      tokens: uniqueTokens,
      trustlines: uniqueTrustlines,
      snippet: bodyText.slice(0, 2500)
    };
  });
}

export async function collectWalletSnapshotWithContext(
  context: BrowserContext,
  walletUrl: string
): Promise<WalletTokenSnapshot> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(walletUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  await page.mouse.wheel(0, 1800).catch(() => {});
  await page.waitForTimeout(1200);

  const snapshot = await extractWalletTokenSnapshot(page);
  await page.close().catch(() => {});
  return snapshot;
}

export async function collectWalletSnapshotWithBrowser(walletUrl: string): Promise<WalletTokenSnapshot> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    return await collectWalletSnapshotWithContext(context, walletUrl);
  } finally {
    await browser.close();
  }
}

function printWalletSnapshot(walletUrl: string, result: WalletTokenSnapshot): void {
  console.log(`[wallet-check] url=${walletUrl}`);
  console.log(`[wallet-check] title=${result.pageTitle}`);
  console.log(`[wallet-check] hasWalletBalance=${result.hasWalletBalance}`);
  console.log(`[wallet-check] hasTokensSection=${result.hasTokensSection}`);
  console.log(`[wallet-check] tokenLinks=${result.tokenCountFromLinks}`);
  console.log(`[wallet-check] trustlineLinks=${result.trustlineCountFromLinks}`);
  console.log(`[wallet-check] tokenRows=${result.tokens.length}`);
  for (const token of result.tokens) {
    console.log(`- ${token}`);
  }
  if (result.trustlines.length > 0) {
    console.log(`[wallet-check] trustlineRows=${result.trustlines.length}`);
    for (const row of result.trustlines) {
      console.log(`* ${row}`);
    }
  }
}

async function main(): Promise<void> {
  const walletUrl = await resolveWalletUrl();
  const result = await collectWalletSnapshotWithBrowser(walletUrl);
  printWalletSnapshot(walletUrl, result);
}

const currentFile = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] ? path.resolve(process.argv[1]) === currentFile : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[wallet-check] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}