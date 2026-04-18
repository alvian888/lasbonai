import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type ProbeResult = {
  ts: string;
  ok: boolean;
  connected: boolean;
  address: string;
  page: string;
  raw: string;
  error: string;
};

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function parseNumberArg(flag: string, fallback: number): number {
  const v = Number(getArg(flag, String(fallback)));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function runProbe(projectRoot: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const cmdArgs = [
      "--prefix",
      projectRoot,
      "exec",
      "tsx",
      path.join(projectRoot, "src", "connect-xpmarket-wallet.ts"),
      "--headless"
    ];

    const child = spawn("npm", cmdArgs, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });

    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    child.on("close", (code) => {
      const raw = `${stdout}${stderr}`.trim();
      const connectedMatch = raw.match(/\[xpmarket\]\s+connected=true\s+address=([^\s]+)/i);
      const pageMatch = raw.match(/\[xpmarket\]\s+page=(.+)/i);

      resolve({
        ts: new Date().toISOString(),
        ok: code === 0,
        connected: Boolean(connectedMatch),
        address: connectedMatch?.[1] ?? "",
        page: pageMatch?.[1]?.trim() ?? "",
        raw,
        error: code === 0 ? "" : `exit_code_${code}`
      });
    });
  });
}

async function appendLog(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const intervalMs = parseNumberArg("--interval-ms", 60_000);
  const iterations = parseNumberArg("--iterations", 0); // 0 = infinite
  const outFile = getArg("--out", path.join(projectRoot, "logs", "xpmarket-health.log"));

  let count = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[watch] start interval=${intervalMs}ms iterations=${iterations === 0 ? "infinite" : iterations}`);
  console.log(`[watch] log=${outFile}`);

  while (!stopped) {
    const result = await runProbe(projectRoot);
    const line = JSON.stringify(result);

    await appendLog(outFile, line);

    if (result.ok && result.connected) {
      console.log(`[watch] ok connected address=${result.address}`);
    } else if (result.ok) {
      console.log("[watch] ok but wallet not detected as connected");
    } else {
      console.log(`[watch] fail ${result.error}`);
    }

    count += 1;
    if (iterations > 0 && count >= iterations) {
      break;
    }

    const until = Date.now() + intervalMs;
    while (!stopped && Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  console.log("[watch] stopped");
}

main().catch((err) => {
  console.error("[watch] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
