import fs from "node:fs/promises";
import path from "node:path";

type ActivityEntry = {
  id?: number;
  method?: string;
  methodType?: string;
  origin?: string;
  requestTime?: number;
  responseTime?: number;
  success?: boolean;
};

type SnapInfo = {
  enabled?: boolean;
  version?: string;
  status?: string;
};

type Subject = {
  permissions?: Record<string, unknown>;
};

type RootState = {
  activeTab?: {
    title?: string;
    origin?: string;
    url?: string;
  };
  metamask?: {
    isInitialized?: boolean;
    isUnlocked?: boolean;
    selectedAddress?: string;
    snaps?: Record<string, SnapInfo>;
    subjects?: Record<string, Subject>;
    permissionActivityLog?: ActivityEntry[];
  };
};

function getArg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function toIso(epochMs?: number): string {
  return epochMs && Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : "";
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const inputPath = path.resolve(getArg("--file", "/home/lasbonai/Downloads/MetaMask state logs.json"));
  const outputPath = path.resolve(
    getArg("--out", path.join(projectRoot, "data", "reports", "xpmarket-snap-activity.json"))
  );

  const raw = await fs.readFile(inputPath, "utf8");
  const data = JSON.parse(raw) as RootState;
  const metamask = data.metamask ?? {};
  const activity = metamask.permissionActivityLog ?? [];
  const subjects = metamask.subjects ?? {};
  const xrplSnap = metamask.snaps?.["npm:xrpl-snap"] ?? {};
  const xpmarketPermissions = subjects["https://xpmarket.com"]?.permissions ?? {};

  const relevant = activity.filter(
    (entry) =>
      entry.origin === "https://xpmarket.com" ||
      entry.origin === "npm:xrpl-snap" ||
      entry.method === "wallet_getSnaps" ||
      entry.method === "wallet_requestSnaps" ||
      entry.method === "wallet_invokeSnap"
  );

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    sourceFile: inputPath,
    verdict: {
      initialized: Boolean(metamask.isInitialized),
      unlocked: Boolean(metamask.isUnlocked),
      xrplSnapEnabled: Boolean(xrplSnap.enabled),
      xpmarketWalletSnapPermission: Object.prototype.hasOwnProperty.call(xpmarketPermissions, "wallet_snap"),
      activeWalletPage: data.activeTab?.url ?? ""
    },
    activeTab: data.activeTab ?? {},
    wallet: {
      selectedAddress: metamask.selectedAddress ?? "",
      xrplSnapVersion: xrplSnap.version ?? "",
      xrplSnapStatus: xrplSnap.status ?? ""
    },
    totals: {
      relevantEvents: relevant.length,
      walletInvokeSnap: relevant.filter((entry) => entry.method === "wallet_invokeSnap").length,
      walletRequestSnaps: relevant.filter((entry) => entry.method === "wallet_requestSnaps").length,
      snapDialog: relevant.filter((entry) => entry.method === "snap_dialog").length
    },
    recentFlow: relevant.slice(-50).map((entry) => ({
      id: entry.id ?? null,
      origin: entry.origin ?? "",
      method: entry.method ?? "",
      methodType: entry.methodType ?? "",
      requestTime: entry.requestTime ?? null,
      requestIso: toIso(entry.requestTime),
      responseTime: entry.responseTime ?? null,
      responseIso: toIso(entry.responseTime),
      success: entry.success ?? null
    }))
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(exportPayload, null, 2)}\n`, "utf8");

  console.log(`[export] saved=${outputPath}`);
  console.log(`[export] relevantEvents=${exportPayload.totals.relevantEvents}`);
  console.log(`[export] walletInvokeSnap=${exportPayload.totals.walletInvokeSnap}`);
  console.log(`[export] walletRequestSnaps=${exportPayload.totals.walletRequestSnaps}`);
  console.log(`[export] snapDialog=${exportPayload.totals.snapDialog}`);
}

main().catch((error) => {
  console.error("[export] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});