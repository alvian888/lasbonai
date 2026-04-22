import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";

interface StoredXrplWallet {
  classicAddress: string;
  seed: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS_DIR = path.join(ROOT, "secrets");
const WALLET_FILE = path.join(SECRETS_DIR, "xrpl-wallet.json");
const FORCE_NEW = process.argv.includes("--force-new");

async function loadExistingWallet(): Promise<StoredXrplWallet | null> {
  try {
    const raw = await fs.readFile(WALLET_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredXrplWallet>;
    if (
      parsed.classicAddress &&
      parsed.seed &&
      parsed.publicKey &&
      parsed.privateKey &&
      parsed.createdAt
    ) {
      return parsed as StoredXrplWallet;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeWallet(wallet: StoredXrplWallet): Promise<void> {
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  await fs.writeFile(WALLET_FILE, JSON.stringify(wallet, null, 2), { mode: 0o600 });
}

function createWallet(): StoredXrplWallet {
  const wallet = Wallet.generate();
  return {
    classicAddress: wallet.classicAddress,
    seed: wallet.seed!,
    publicKey: wallet.publicKey,
    privateKey: wallet.privateKey,
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  if (!FORCE_NEW) {
    const existing = await loadExistingWallet();
    if (existing) {
      console.log("[xrpl-wallet] existing wallet loaded from secrets/xrpl-wallet.json");
      console.log(`[xrpl-wallet] classicAddress=${existing.classicAddress}`);
      return;
    }
  }

  const wallet = createWallet();
  await writeWallet(wallet);

  console.log("[xrpl-wallet] new XRPL wallet generated and saved to secrets/xrpl-wallet.json");
  console.log(`[xrpl-wallet] classicAddress=${wallet.classicAddress}`);
  console.log("[xrpl-wallet] seed/privateKey stored only in secrets file (not echoed to terminal)");
}

main().catch((error) => {
  console.error("[xrpl-wallet] failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});