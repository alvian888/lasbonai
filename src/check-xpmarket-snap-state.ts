import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

type SubjectPermissions = {
  permissions?: Record<string, unknown>;
};

type ActivityEntry = {
  method?: string;
  origin?: string;
  requestTime?: number;
  responseTime?: number;
  success?: boolean;
};

type MetaMaskState = {
  isInitialized?: boolean;
  isUnlocked?: boolean;
  selectedAddress?: string;
  snaps?: Record<string, { enabled?: boolean; version?: string; status?: string }>;
  subjects?: Record<string, SubjectPermissions>;
  permissionActivityLog?: ActivityEntry[];
};

type RootState = {
  activeTab?: {
    title?: string;
    origin?: string;
    url?: string;
  };
  metamask?: MetaMaskState;
};

type HistorySignals = {
  historyUrl: string;
  reachable: boolean;
  hasTransactionHistory: boolean;
  hasTrustlineSetEvent: boolean;
  hasSuccessStatus: boolean;
  rowCount: number;
  sampleRows: string[];
  error?: string;
};

function getArg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function formatTime(epochMs?: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "";
  return new Date(epochMs).toISOString();
}

function summarizeRecentFlow(entries: ActivityEntry[]): string[] {
  const filtered = entries
    .filter(
      (entry) =>
        entry.origin === "https://xpmarket.com" ||
        entry.origin === "npm:xrpl-snap" ||
        entry.method === "wallet_getSnaps" ||
        entry.method === "wallet_requestSnaps" ||
        entry.method === "wallet_invokeSnap"
    )
    .slice(-20);

  return filtered.map((entry) => {
    const status = entry.success === true ? "ok" : entry.success === false ? "fail" : "unknown";
    return `${formatTime(entry.requestTime)} ${entry.origin ?? ""} ${entry.method ?? ""} ${status}`.trim();
  });
}

function extractWalletAddress(walletUrl: string): string {
  const match = walletUrl.match(/^https:\/\/xpmarket\.com\/wallet\/(r[1-9A-Za-z]{20,})/);
  return match?.[1] ?? "";
}

async function inspectWalletHistory(historyUrl: string): Promise<HistorySignals> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(historyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3500);

    const result = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const rows = Array.from(document.querySelectorAll('[role="row"]'))
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const hasTransactionHistory = /transaction history/i.test(bodyText);
      const hasTrustlineSetEvent = rows.some((row) => /trust\s*set|trustline\s*set/i.test(row));
      const hasSuccessStatus = rows.some((row) => /success/i.test(row));

      return {
        hasTransactionHistory,
        hasTrustlineSetEvent,
        hasSuccessStatus,
        rowCount: rows.length,
        sampleRows: rows.slice(0, 12)
      };
    });

    return {
      historyUrl,
      reachable: true,
      hasTransactionHistory: result.hasTransactionHistory,
      hasTrustlineSetEvent: result.hasTrustlineSetEvent,
      hasSuccessStatus: result.hasSuccessStatus,
      rowCount: result.rowCount,
      sampleRows: result.sampleRows
    };
  } catch (error) {
    return {
      historyUrl,
      reachable: false,
      hasTransactionHistory: false,
      hasTrustlineSetEvent: false,
      hasSuccessStatus: false,
      rowCount: 0,
      sampleRows: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const defaultPath = "/home/lasbonai/Downloads/MetaMask state logs.json";
  const filePath = path.resolve(getArg("--file", defaultPath));
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw) as RootState;
  const metamask = data.metamask ?? {};
  const subjects = metamask.subjects ?? {};
  const snaps = metamask.snaps ?? {};
  const activity = metamask.permissionActivityLog ?? [];

  const xrplSnap = snaps["npm:xrpl-snap"];
  const xpmarketPermissions = subjects["https://xpmarket.com"]?.permissions ?? {};
  const hasXpmarketWalletSnap = Object.prototype.hasOwnProperty.call(xpmarketPermissions, "wallet_snap");

  const walletPageUrl = data.activeTab?.url ?? "";
  const walletPageActive = /^https:\/\/xpmarket\.com\/wallet\/r[1-9A-Za-z]{20,}/.test(walletPageUrl);
  const walletAddress = extractWalletAddress(walletPageUrl);

  const historyUrl = walletAddress
    ? `https://xpmarket.com/wallet/${walletAddress}?active=history`
    : "";

  let historySignals: HistorySignals | null = null;
  if (historyUrl) {
    historySignals = await inspectWalletHistory(historyUrl);
  }

  const recentFlow = summarizeRecentFlow(activity);
  const hasSuccessfulReconnectFlow = recentFlow.some((line) => line.includes("wallet_requestSnaps ok"))
    && recentFlow.some((line) => line.includes("wallet_invokeSnap ok"));

  const hasHistoryConnectionEvidence = Boolean(
    historySignals?.reachable
      && historySignals.hasTransactionHistory
      && historySignals.hasTrustlineSetEvent
      && historySignals.hasSuccessStatus
  );

  console.log(`[state] file=${filePath}`);
  console.log(`[state] metamask.initialized=${Boolean(metamask.isInitialized)}`);
  console.log(`[state] metamask.unlocked=${Boolean(metamask.isUnlocked)}`);
  console.log(`[state] metamask.selectedAddress=${metamask.selectedAddress ?? ""}`);
  console.log(`[state] xrplSnap.installed=${Boolean(xrplSnap)}`);
  console.log(`[state] xrplSnap.enabled=${Boolean(xrplSnap?.enabled)}`);
  console.log(`[state] xrplSnap.version=${xrplSnap?.version ?? ""}`);
  console.log(`[state] xpmarket.walletSnapPermission=${hasXpmarketWalletSnap}`);
  console.log(`[state] xpmarket.walletPageActive=${walletPageActive}`);
  console.log(`[state] xpmarket.walletPageUrl=${walletPageUrl}`);
  console.log(`[state] reconnectFlowDetected=${hasSuccessfulReconnectFlow}`);
  console.log(`[state] history.url=${historySignals?.historyUrl ?? ""}`);
  console.log(`[state] history.reachable=${Boolean(historySignals?.reachable)}`);
  console.log(`[state] history.hasTransactionHistory=${Boolean(historySignals?.hasTransactionHistory)}`);
  console.log(`[state] history.hasTrustlineSetEvent=${Boolean(historySignals?.hasTrustlineSetEvent)}`);
  console.log(`[state] history.hasSuccessStatus=${Boolean(historySignals?.hasSuccessStatus)}`);
  console.log(`[state] history.rowCount=${historySignals?.rowCount ?? 0}`);
  console.log(`[state] history.connectionEvidence=${hasHistoryConnectionEvidence}`);
  if (historySignals?.error) {
    console.log(`[state] history.error=${historySignals.error}`);
  }

  if (historySignals && historySignals.sampleRows.length > 0) {
    console.log("[state] history.sampleRows");
    for (const row of historySignals.sampleRows) {
      console.log(`- ${row}`);
    }
  }

  console.log("[state] recentFlow");
  for (const line of recentFlow) {
    console.log(`- ${line}`);
  }

  const verdict =
    Boolean(metamask.isInitialized) &&
    Boolean(metamask.isUnlocked) &&
    Boolean(xrplSnap?.enabled) &&
    hasXpmarketWalletSnap &&
    (walletPageActive || hasSuccessfulReconnectFlow || hasHistoryConnectionEvidence);

  console.log(`[state] verdict=${verdict ? "PASS" : "FAIL"}`);

  if (!verdict) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[state] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});