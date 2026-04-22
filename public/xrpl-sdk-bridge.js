import { Client, isValidClassicAddress, xrpToDrops } from "https://esm.sh/xrpl@4.6.0?bundle";

const XRPL_WS_ENDPOINTS = [
  "wss://xrplcluster.com",
  "wss://xrpl.link",
  "wss://s1.ripple.com",
];

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function createSdkSummary(walletAddress, amountXrp) {
  return {
    loaded: true,
    walletAddress: walletAddress || "",
    walletValid: walletAddress ? isValidClassicAddress(walletAddress) : false,
    sampleAmountXrp: amountXrp,
    sampleAmountDrops: null,
    endpoint: "",
    connected: false,
    networkId: null,
    ledgerIndex: null,
    reserveBaseXrp: null,
    reserveIncrementXrp: null,
    error: null,
  };
}

function applyDropsPreview(summary, amountXrp) {
  try {
    summary.sampleAmountDrops = xrpToDrops(amountXrp);
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }
}

function applyServerInfo(summary, endpoint, response) {
  const info = response?.result?.info || {};
  summary.endpoint = endpoint;
  summary.connected = true;
  summary.networkId = info.network_id ?? null;
  summary.ledgerIndex = info.validated_ledger?.seq ?? null;
  summary.reserveBaseXrp = info.validated_ledger?.reserve_base_xrp ?? null;
  summary.reserveIncrementXrp = info.validated_ledger?.reserve_inc_xrp ?? null;
  summary.error = null;
}

async function disconnectQuietly(client) {
  try {
    if (client.isConnected()) {
      await client.disconnect();
    }
  } catch {
    // ignore disconnect cleanup failures
  }
}

async function probeEndpoint(summary, endpoint) {
  const client = new Client(endpoint);
  try {
    await withTimeout(client.connect(), 9000, `XRPL connect ${endpoint}`);
    const response = await withTimeout(
      client.request({ command: "server_info" }),
      9000,
      `XRPL server_info ${endpoint}`,
    );
    applyServerInfo(summary, endpoint, response);
    await client.disconnect();
    return null;
  } catch (error) {
    await disconnectQuietly(client);
    return error instanceof Error ? error.message : String(error);
  }
}

export async function inspectXrplSdk(walletAddress, amountXrp = "10") {
  const summary = createSdkSummary(walletAddress, amountXrp);
  applyDropsPreview(summary, amountXrp);

  let lastError = summary.error;
  for (const endpoint of XRPL_WS_ENDPOINTS) {
    const endpointError = await probeEndpoint(summary, endpoint);
    if (!endpointError) {
      return summary;
    }
    lastError = endpointError;
  }

  summary.error = lastError || "Unable to reach XRPL WebSocket endpoints";
  return summary;
}