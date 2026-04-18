import { config, hasTelegramConfig } from "./config.js";

function requireBotToken() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  }
}

async function getUpdates() {
  requireBotToken();

  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?limit=20&timeout=10`
  );
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: unknown[] } | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(`Failed to read Telegram updates. HTTP ${response.status}`);
  }

  const simplified = (payload.result ?? []).map((entry) => {
    const item = (entry ?? {}) as {
      update_id?: number;
      message?: {
        chat?: { id?: number; username?: string; type?: string };
        from?: { username?: string; first_name?: string };
        text?: string;
      };
    };

    return {
      updateId: item.update_id,
      chatId: item.message?.chat?.id,
      chatUsername: item.message?.chat?.username,
      chatType: item.message?.chat?.type,
      from: item.message?.from?.username ?? item.message?.from?.first_name,
      text: item.message?.text
    };
  });

  console.log(JSON.stringify({ ok: true, count: simplified.length, updates: simplified }, null, 2));
}

async function sendTestMessage() {
  if (!hasTelegramConfig()) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  }

  const message = process.argv.slice(3).join(" ") || "OKX bot test notification.";
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    })
  });

  const payload = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Telegram send failed. HTTP ${response.status}: ${payload}`);
  }

  console.log(payload);
}

async function main() {
  const command = process.argv[2] ?? "get-updates";

  if (command === "get-updates") {
    await getUpdates();
    return;
  }

  if (command === "send-test") {
    await sendTestMessage();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});