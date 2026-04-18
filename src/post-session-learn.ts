/**
 * post-session-learn.ts
 *
 * Lightweight post-session analysis for lasbonai_xpmarket.
 * Reads Chrome log, filters real errors, generates a brief report,
 * and appends to the cumulative learning log.
 *
 * No headless browser — just file I/O.
 */

import path from "node:path";
import fs from "node:fs/promises";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const PROFILE_DIR = path.join(ROOT, "data/browser-profile");
const LOG_DIR = path.join(ROOT, "logs/runs");
const AGENT_DOCS = path.join(ROOT, "..", "tekad-agent-docs");

const STAMP = process.env.SESSION_STAMP ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const CHROME_LOG = process.env.CHROME_LOG_PATH ?? "";
const EXIT_CODE = parseInt(process.env.SESSION_EXIT_CODE ?? "0", 10);
const SESSION_START = process.env.SESSION_START ?? "";
const SESSION_END = process.env.SESSION_END ?? new Date().toISOString();

// ─── Noise filter ───────────────────────────────────────────────

function isBenignNoise(line: string): boolean {
  return (
    /^Histogram:|recorded \d+ samples|\(flags = 0x/i.test(line) ||
    /"polledData":|"activeFieldTrialGroups"/.test(line) ||
    /\bVERBOSE1\b/.test(line) ||
    /Removing intrinsics|Removing unpermitted/i.test(line) ||
    /vaapi_wrapper|InitializeSandbox.*multiple threads|Should skip nVidia/i.test(line) ||
    /browser_user_education/i.test(line) ||
    /New Relic Warning/i.test(line) ||
    /^\s*\{"params":/i.test(line) ||
    /"close_type"|"quic_error"|after_active_sessions_size/i.test(line) ||
    /RegistrationRequest|registration_request\.cc/i.test(line) ||
    /zygote_communication.*Socket closed/i.test(line) ||
    /CONSOLE.*WARNING: Missing strong random/i.test(line) ||
    /DNS\.HTTPSSVC|DnsTask\.Svcb/i.test(line)
  );
}

function extractErrors(log: string, max = 50): string[] {
  return log
    .split("\n")
    .filter((l) => l.trim() && !isBenignNoise(l) && /error|crash|fatal|exception|fail|refused|SIGSEGV/i.test(l))
    .slice(-max);
}

// ─── Report ─────────────────────────────────────────────────────

interface SessionData {
  stamp: string;
  exitCode: number;
  crashDetected: boolean;
  durationSeconds: number;
  errors: string[];
  errorCount: number;
  mmExtensionExists: boolean;
  crashpadExists: boolean;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function generateReport(d: SessionData): string {
  const dur = d.durationSeconds > 0
    ? `${Math.floor(d.durationSeconds / 60)}m ${Math.round(d.durationSeconds % 60)}s`
    : "?";
  const status = d.crashDetected ? "🔴 CRASH" : d.exitCode !== 0 ? "🟡 ERROR" : "🟢 CLEAN";

  let md = `# Session ${d.stamp} — ${status}\n\n`;
  md += `| Field | Value |\n|---|---|\n`;
  md += `| Duration | ${dur} |\n`;
  md += `| Exit Code | ${d.exitCode} |\n`;
  md += `| Errors | ${d.errorCount} |\n`;
  md += `| Crashpad | ${d.crashpadExists ? "⚠ exists" : "clean"} |\n\n`;

  if (d.errors.length > 0) {
    md += `## Errors\n\`\`\`\n${d.errors.slice(0, 20).join("\n")}\n\`\`\`\n`;
  }

  md += `\n---\n*Generated ${d.stamp}*\n`;
  return md;
}

async function appendLearningLog(d: SessionData): Promise<void> {
  const logFile = path.join(AGENT_DOCS, "SESSION-LEARNING-LOG.md");
  const status = d.crashDetected ? "CRASH" : d.exitCode !== 0 ? "ERROR" : "CLEAN";
  const dur = d.durationSeconds > 0
    ? `${Math.floor(d.durationSeconds / 60)}m${Math.round(d.durationSeconds % 60)}s`
    : "?";

  let header = "";
  if (!(await exists(logFile))) {
    header = `# XPMarket Session Learning Log\n\n`;
    header += `| Date | Status | Duration | Exit | Errors | Notes |\n`;
    header += `|------|--------|----------|------|--------|-------|\n`;
  }

  const notes = d.crashDetected ? "crash" : d.errorCount > 0 ? `err:${d.errorCount}` : "clean";
  const row = `| ${d.stamp} | ${status} | ${dur} | ${d.exitCode} | ${d.errorCount} | ${notes} |\n`;

  await fs.appendFile(logFile, header + row);
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.mkdir(AGENT_DOCS, { recursive: true });

  // Read Chrome log
  let chromeLog = "";
  if (CHROME_LOG) {
    try { chromeLog = await fs.readFile(CHROME_LOG, "utf-8"); } catch {}
  }
  const errors = extractErrors(chromeLog);

  // Crash detection — real signals only
  const crashpadExists = await exists(path.join(PROFILE_DIR, "Crashpad/pending"));
  const hasRealCrash = errors.some(
    (e) => /SIGSEGV|SIGABRT|SIGBUS|SIGFPE|segmentation fault/i.test(e)
  );
  const crashDetected = EXIT_CODE !== 0 && (hasRealCrash || crashpadExists);

  // Duration
  let durationSeconds = 0;
  if (SESSION_START && SESSION_END) {
    const s = new Date(SESSION_START).getTime();
    const e = new Date(SESSION_END).getTime();
    if (!isNaN(s) && !isNaN(e)) durationSeconds = (e - s) / 1000;
  }

  const data: SessionData = {
    stamp: STAMP,
    exitCode: EXIT_CODE,
    crashDetected,
    durationSeconds,
    errors,
    errorCount: errors.length,
    mmExtensionExists: await exists(path.join(PROFILE_DIR, "Default/Extensions")),
    crashpadExists,
  };

  // Save JSON + report
  await fs.writeFile(path.join(LOG_DIR, `${STAMP}-debug.json`), JSON.stringify(data, null, 2));
  await fs.writeFile(path.join(LOG_DIR, `${STAMP}-report.md`), generateReport(data));
  await appendLearningLog(data);

  // Summary
  const status = crashDetected ? "🔴 CRASH" : EXIT_CODE !== 0 ? "🟡 ERROR" : "🟢 CLEAN";
  console.log(`[post-session] ${status} | errors: ${errors.length} | exit: ${EXIT_CODE}`);
}

main().catch((err) => {
  console.error("[post-session] fatal:", err);
  process.exitCode = 1;
});
