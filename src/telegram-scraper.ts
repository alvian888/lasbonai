import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(currentDir, "../data");

export interface TelegramMessage {
  text: string;
  date: string;
  messageId?: string;
}

export interface ScrapeResult {
  channel: string;
  scrapedAt: string;
  messageCount: number;
  messages: TelegramMessage[];
}

/**
 * Scrape messages from a public Telegram channel web preview.
 * Uses https://t.me/s/<channel> which requires no authentication.
 */
export async function scrapeTelegramChannel(
  channelUrl: string,
  limit = 50
): Promise<ScrapeResult> {
  const match = channelUrl.match(/(?:https?:\/\/)?t\.me\/(?:s\/)?(\w+)/);
  if (!match) throw new Error(`Invalid Telegram channel URL: ${channelUrl}`);

  const channelName = match[1];
  const webPreviewUrl = `https://t.me/s/${channelName}`;

  console.log(`[telegram-scraper] Fetching ${webPreviewUrl}`);

  const response = await fetch(webPreviewUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch channel. HTTP ${response.status}`);
  }

  const html = await response.text();
  const messages = parseChannelHtml(html, limit);

  const result: ScrapeResult = {
    channel: channelName,
    scrapedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages
  };

  const outPath = resolve(dataDir, "telegram-sentiment.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`[telegram-scraper] Saved ${messages.length} messages to ${outPath}`);

  return result;
}

function parseChannelHtml(html: string, limit: number): TelegramMessage[] {
  const messages: TelegramMessage[] = [];

  // Primary regex: extract message blocks with post ID, text, and datetime
  const messageBlockRegex =
    /data-post="([^"]*)"[\s\S]*?<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<time[^>]*datetime="([^"]*)"[^>]*>/g;

  let m;
  while ((m = messageBlockRegex.exec(html)) !== null && messages.length < limit) {
    const [, postId, rawText, dateStr] = m;
    const text = stripHtml(rawText).trim();
    if (text) {
      messages.push({ messageId: postId, text, date: dateStr });
    }
  }

  // Fallback: simpler extraction if the primary regex missed messages
  if (messages.length === 0) {
    const textRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    const dateRegex = /<time[^>]*datetime="([^"]*)"[^>]*>/g;

    const texts: string[] = [];
    const dates: string[] = [];

    let t;
    while ((t = textRegex.exec(html)) !== null) texts.push(stripHtml(t[1]).trim());
    while ((t = dateRegex.exec(html)) !== null) dates.push(t[1]);

    for (let i = 0; i < Math.min(texts.length, limit); i++) {
      if (texts[i]) {
        messages.push({ text: texts[i], date: dates[i] || new Date().toISOString() });
      }
    }
  }

  return messages;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Load previously saved scrape result from disk.
 */
export async function loadSavedScrape(): Promise<ScrapeResult | null> {
  try {
    const filePath = resolve(dataDir, "telegram-sentiment.json");
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as ScrapeResult;
  } catch {
    return null;
  }
}

// ── CLI entry point ──
if (process.argv[1]?.endsWith("telegram-scraper.ts") || process.argv[1]?.endsWith("telegram-scraper.js")) {
  const url = process.argv[2] || "https://t.me/kaptencrypto707";
  scrapeTelegramChannel(url)
    .then((r) => console.log(`Done. ${r.messageCount} messages scraped from @${r.channel}`))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
