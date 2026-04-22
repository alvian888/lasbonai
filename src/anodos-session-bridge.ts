import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = resolve(currentDir, "../data/anodos-session-status.json");

export interface AnodosSessionStatus {
  source: string;
  reachable: boolean;
  blocked: boolean;
  hasXrplHint: boolean;
  preview: string;
  updatedAt: string;
}

function parseHtml(html: string) {
  const lowered = html.toLowerCase();
  return {
    blocked: lowered.includes("vercel security checkpoint"),
    hasXrplHint: lowered.includes("xrpl") || lowered.includes("xrp") || lowered.includes("ripple"),
  };
}

export async function writeAnodosSessionStatus(input: {
  source: string;
  html: string;
  reachable: boolean;
}) {
  const parsed = parseHtml(input.html);
  const payload: AnodosSessionStatus = {
    source: input.source,
    reachable: input.reachable,
    blocked: parsed.blocked,
    hasXrplHint: parsed.hasXrplHint,
    preview: input.html.slice(0, 400),
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(STATUS_FILE), { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export async function readAnodosSessionStatus(maxAgeMs = 10 * 60 * 1000): Promise<AnodosSessionStatus | null> {
  try {
    const raw = await readFile(STATUS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AnodosSessionStatus>;
    if (!parsed || typeof parsed.updatedAt !== "string") return null;

    const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return null;

    if (
      typeof parsed.source !== "string" ||
      typeof parsed.reachable !== "boolean" ||
      typeof parsed.blocked !== "boolean" ||
      typeof parsed.hasXrplHint !== "boolean" ||
      typeof parsed.preview !== "string"
    ) {
      return null;
    }

    return {
      source: parsed.source,
      reachable: parsed.reachable,
      blocked: parsed.blocked,
      hasXrplHint: parsed.hasXrplHint,
      preview: parsed.preview,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}
