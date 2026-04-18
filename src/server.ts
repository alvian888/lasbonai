import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import OpenAI from "openai";
import { config } from "./config.js";
import { AgenticTradingBot } from "./bot.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

const app = express();
const bot = new AgenticTradingBot();
const currentDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(currentDir, "../public");

const requestSchema = z.object({
  chainId: z.string(),
  walletAddress: z.string(),
  baseTokenAddress: z.string(),
  quoteTokenAddress: z.string(),
  buyAmount: z.string(),
  sellAmount: z.string(),
  slippage: z.string().optional(),
  marketContext: z.string().optional()
});

app.use(express.json());
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, dryRun: config.DRY_RUN, model: config.OPENAI_MODEL });
});

app.post("/api/bot/run", async (req, res) => {
  try {
    const parsed = requestSchema.parse(req.body);
    const result = await bot.run(parsed);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

// ─── Chat API (Ollama AI Assistant) ─────────────────────────────

const chatClient = new OpenAI({
  apiKey: "ollama",
  baseURL: "http://127.0.0.1:11434/v1"
});

const knowledgePath = resolve(currentDir, "../data/knowledge/project-context.md");

const chatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string()
  })).max(20).default([])
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = chatRequestSchema.parse(req.body);

    let knowledgeBase = "";
    try {
      knowledgeBase = await readFile(knowledgePath, "utf-8");
    } catch {
      knowledgeBase = "Knowledge base not available.";
    }

    const systemPrompt = `Kamu adalah AI assistant untuk OKX Agentic Trading Bot milik LasbonAI.
Kamu membantu owner (Rahmat Ginanjar / lasbonai) memahami dan mengelola bot trading crypto-nya.
Jawab dalam bahasa yang sama dengan pertanyaan user (Indonesia atau English).
Berdasarkan knowledge base berikut, jawab pertanyaan dengan akurat dan ringkas.

--- KNOWLEDGE BASE ---
${knowledgeBase}
--- END KNOWLEDGE BASE ---

Aturan:
- Jawab berdasarkan data di knowledge base, jangan mengarang data
- Jika ditanya tentang harga real-time, katakan bahwa kamu tidak punya akses real-time, tapi bisa kasih info dari knowledge base
- Untuk pertanyaan trading, selalu ingatkan risk management
- Bisa jelaskan arsitektur, strategi, config, dan status bot
- Gunakan format markdown untuk jawaban yang rapi`;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...history.map(h => ({ role: h.role as "user" | "assistant", content: h.content })),
      { role: "user", content: message }
    ];

    const completion = await chatClient.chat.completions.create({
      model: "lasbonai:latest",
      temperature: 0.3,
      messages
    });

    const reply = completion.choices[0]?.message?.content ?? "Maaf, tidak ada respons dari AI.";
    res.json({ reply });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[chat] ${message}`);
    res.status(500).json({ error: "AI service error", message });
  }
});

app.listen(config.PORT, () => {
  console.log(`OKX agentic bot listening on http://127.0.0.1:${config.PORT}`);
  startScheduler(bot);
});

process.on("SIGINT", () => {
  stopScheduler();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopScheduler();
  process.exit(0);
});