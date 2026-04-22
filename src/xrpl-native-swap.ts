const ANODOS_URL = "https://dex.anodos.finance/portfolio";
import { readAnodosSessionStatus } from "./anodos-session-bridge.js";
import { assertXrplNativeExecutionReady, config, getXrplNativeExecutionWallet } from "./config.js";

interface XrplExecutorResponse {
  ok?: boolean;
  success?: boolean;
  txHash?: string;
  txUrl?: string;
  data?: {
    txHash?: string;
    txUrl?: string;
  };
  result?: {
    txHash?: string;
    txUrl?: string;
  };
  error?: string;
}

export interface XrplSwapRequest {
  fromToken: string;
  toToken: string;
  amount: string;
  slippage?: string;
  dryRun?: boolean;
}

export interface XrplSwapResult {
  ok: boolean;
  success: boolean;
  txUrl?: string;
  provider: "dex.anodos.finance";
  blocked?: boolean;
  liveReady?: boolean;
  output: string;
}

function getXrplExecutorConfig() {
  return {
    executeUrl: config.XRPL_NATIVE_EXECUTE_URL,
    apiKey: config.XRPL_NATIVE_EXECUTE_API_KEY,
    wallet: getXrplNativeExecutionWallet(),
    timeoutMs: config.XRPL_NATIVE_EXECUTE_TIMEOUT_MS,
  };
}

function parseAnodosStatus(html: string) {
  const lowered = html.toLowerCase();
  return {
    blocked: lowered.includes("vercel security checkpoint"),
    hasXrplHint: lowered.includes("xrpl") || lowered.includes("xrp") || lowered.includes("ripple"),
  };
}

export interface XrplAnodosStatus {
  source: string;
  reachable: boolean;
  blocked: boolean;
  hasXrplHint: boolean;
  preview: string;
}

export async function getXrplAnodosStatus(): Promise<XrplAnodosStatus> {
  const bridged = await readAnodosSessionStatus();
  if (bridged) {
    return {
      source: bridged.source,
      reachable: bridged.reachable,
      blocked: bridged.blocked,
      hasXrplHint: bridged.hasXrplHint,
      preview: bridged.preview,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(ANODOS_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "okx-agentic-bot/1.0" },
    });
    const html = await response.text().catch(() => "");
    const status = parseAnodosStatus(html);
    return {
      source: ANODOS_URL,
      reachable: response.ok,
      ...status,
      preview: html.slice(0, 400),
    };
  } catch {
    return {
      source: ANODOS_URL,
      reachable: false,
      blocked: false,
      hasXrplHint: false,
      preview: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeXrplNativeSwap(req: XrplSwapRequest): Promise<XrplSwapResult> {
  const probe = await getXrplAnodosStatus();

  if (req.dryRun) {
    if (!probe.reachable && !probe.blocked) {
      return {
        ok: false,
        success: false,
        provider: "dex.anodos.finance",
        blocked: false,
        output: "DRY-RUN: dex.anodos.finance tidak dapat diakses saat ini.",
      };
    }
    return {
      ok: true,
      success: false,
      provider: "dex.anodos.finance",
      blocked: probe.blocked,
      output: probe.blocked
        ? "DRY-RUN: Anodos reachable tetapi dilindungi Vercel Security Checkpoint."
        : "DRY-RUN: Anodos reachable. Siap lanjutkan swap XRPL manual/interactive.",
    };
  }

  if (probe.blocked) {
    return {
      ok: false,
      success: false,
      provider: "dex.anodos.finance",
      blocked: true,
      liveReady: false,
      output:
        "LIVE-BLOCKED: dex.anodos.finance terproteksi Vercel Security Checkpoint. Gunakan sesi browser interaktif yang sudah lolos checkpoint.",
    };
  }

  if (!probe.reachable) {
    return {
      ok: false,
      success: false,
      provider: "dex.anodos.finance",
      blocked: false,
      liveReady: false,
      output: "LIVE-BLOCKED: dex.anodos.finance tidak dapat diakses saat ini.",
    };
  }

  try {
    assertXrplNativeExecutionReady();
  } catch (error) {
    return {
      ok: false,
      success: false,
      provider: "dex.anodos.finance",
      liveReady: false,
      output: `LIVE-NOT-READY: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const executor = getXrplExecutorConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(executor.timeoutMs) ? executor.timeoutMs : 25_000);
  try {
    const response = await fetch(executor.executeUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(executor.apiKey ? { Authorization: `Bearer ${executor.apiKey}` } : {}),
      },
      body: JSON.stringify({
        fromToken: req.fromToken,
        toToken: req.toToken,
        amount: req.amount,
        slippage: req.slippage || "1",
        wallet: executor.wallet || undefined,
        metadata: {
          source: "okx-agentic-bot",
          mode: "xrpl-native-anodos",
          anodosStatus: probe,
        },
      }),
    });

    const payload = (await response.json().catch(() => null)) as XrplExecutorResponse | null;
    if (!response.ok) {
      return {
        ok: false,
        success: false,
        provider: "dex.anodos.finance",
        liveReady: true,
        output: `LIVE-EXECUTOR-ERROR: HTTP ${response.status} ${response.statusText} ${JSON.stringify(payload)}`,
      };
    }

    const txHash = payload?.txHash || payload?.data?.txHash || payload?.result?.txHash;
    const txUrl = payload?.txUrl || payload?.data?.txUrl || payload?.result?.txUrl;

    if (!txHash && !txUrl) {
      return {
        ok: false,
        success: false,
        provider: "dex.anodos.finance",
        liveReady: true,
        output:
          "LIVE-EXECUTOR-INVALID-RESPONSE: endpoint tidak mengembalikan txHash/txUrl. Sesuaikan schema endpoint executor.",
      };
    }

    return {
      ok: true,
      success: true,
      provider: "dex.anodos.finance",
      liveReady: true,
      txUrl,
      output: txHash
        ? `LIVE-SUBMITTED: txHash=${txHash}${txUrl ? ` txUrl=${txUrl}` : ""}`
        : `LIVE-SUBMITTED: txUrl=${txUrl}`,
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      provider: "dex.anodos.finance",
      liveReady: true,
      output: `LIVE-EXECUTOR-FAILED: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }

}
