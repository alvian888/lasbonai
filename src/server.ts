import "./initialize.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import OpenAI from "openai";
import { config, getXrplNativeAllowedHosts, getXrplNativeExecutionWallet, hasXrplNativeExecutorConfig } from "./config.js";
import { AgenticTradingBot } from "./bot.js";
import { getSchedulerHealthSnapshot, startScheduler, stopScheduler } from "./scheduler.js";
import { getAllNetworkConfigs, grepAnodosPortfolioHints, resolveNetworkConfig } from "./network-registry.js";
import { executeXrplNativeSwap, getXrplAnodosStatus } from "./xrpl-native-swap.js";

const app = express();
const bot = new AgenticTradingBot();
const currentDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(currentDir, "../public");
const portfolioHtml = resolve(publicDir, "index.html");

const requestSchema = z.object({
  chainId: z.string(),
  walletAddress: z.string(),
  baseTokenAddress: z.string(),
  quoteTokenAddress: z.string(),
  buyAmount: z.string(),
  sellAmount: z.string(),
  slippage: z.string().optional(),
  marketContext: z.string().optional(),
  rsi: z.number().optional(),
  macd: z.number().optional(),
  macdSignal: z.number().optional(),
  emaFast: z.number().optional(),
  emaSlow: z.number().optional()
});

const xrplSwapSchema = z.object({
  fromToken: z.string().min(1),
  toToken: z.string().min(1),
  amount: z.string().min(1),
  slippage: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
});

const xrplExecutorRequestSchema = z.object({
  fromToken: z.string().min(1),
  toToken: z.string().min(1),
  amount: z.string().min(1),
  slippage: z.string().optional(),
  wallet: z.string().optional(),
});

app.use(express.json());
app.get("/", (_req, res) => {
  res.redirect(302, "/portfolio");
});

app.get("/portfolio", (_req, res) => {
  res.sendFile(portfolioHtml);
});

app.use(express.static(publicDir, { index: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, dryRun: config.DRY_RUN, model: config.OPENAI_MODEL });
});

app.get("/health/deep", (_req, res) => {
  res.json({
    ok: true,
    dryRun: config.DRY_RUN,
    model: config.OPENAI_MODEL,
    scheduler: getSchedulerHealthSnapshot()
  });
});

app.get("/api/networks", async (_req, res) => {
  const defaultNetwork = resolveNetworkConfig(config.DEFAULT_CHAIN_ID);
  const anodosHints = await grepAnodosPortfolioHints();

  res.json({
    defaultChainId: config.DEFAULT_CHAIN_ID,
    defaultNetwork,
    networks: getAllNetworkConfigs(),
    fallback: {
      xrpl: {
        provider: "dex.anodos.finance",
        url: "https://dex.anodos.finance/portfolio",
        hints: anodosHints,
      },
    },
  });
});

app.get("/api/networks/resolve", async (req, res) => {
  let queryChain = "";
  if (typeof req.query.chain === "string") {
    queryChain = req.query.chain;
  } else if (typeof req.query.chainId === "string") {
    queryChain = req.query.chainId;
  }
  const chain = queryChain.trim();
  if (!chain) {
    res.status(400).json({ error: "Missing query: chain (or chainId)" });
    return;
  }

  const resolved = resolveNetworkConfig(chain);
  const anodosHints = resolved.key === "xrpl" ? await grepAnodosPortfolioHints() : undefined;

  res.json({
    input: chain,
    resolved,
    fallbackHints: anodosHints,
  });
});

app.post("/api/xrpl/swap", async (req, res) => {
  try {
    const body = xrplSwapSchema.parse(req.body);
    const result = await executeXrplNativeSwap(body);

    res.json({
      mode: "xrpl-native-anodos",
      request: body,
      result,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/xrpl/executor/mock", (req, res) => {
  if (!config.XRPL_NATIVE_EXECUTE_MOCK_ENABLED) {
    res.status(403).json({
      ok: false,
      error: "XRPL mock executor is disabled. Set XRPL_NATIVE_EXECUTE_MOCK_ENABLED=true to enable.",
    });
    return;
  }

  const authHeader = String(req.headers.authorization || "").trim();
  if (config.XRPL_NATIVE_EXECUTE_API_KEY) {
    const expected = `Bearer ${config.XRPL_NATIVE_EXECUTE_API_KEY}`;
    if (authHeader !== expected) {
      res.status(401).json({ ok: false, error: "Unauthorized mock executor request." });
      return;
    }
  }

  try {
    const payload = xrplExecutorRequestSchema.parse(req.body);
    const digest = createHash("sha256")
      .update(JSON.stringify(payload))
      .update(String(Date.now()))
      .digest("hex");
    const txHash = `MOCKXRPL_${digest.slice(0, 48)}`;

    res.json({
      ok: true,
      success: true,
      simulated: true,
      provider: "mock-xrpl-executor",
      txHash,
      txUrl: `https://mock.xrpl.local/tx/${txHash}`,
      acceptedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Invalid mock request",
    });
  }
});

app.get("/api/xrpl/status", async (_req, res) => {
  try {
    const status = await getXrplAnodosStatus();
    const hasExecutor = hasXrplNativeExecutorConfig();
    const liveGateOpen = !config.DRY_RUN && config.LIVE_STAGE !== "dry-run";
    const allowedHosts = getXrplNativeAllowedHosts();
    const executorHost = (() => {
      try {
        return config.XRPL_NATIVE_EXECUTE_URL ? new URL(config.XRPL_NATIVE_EXECUTE_URL).hostname.toLowerCase() : "";
      } catch {
        return "";
      }
    })();
    let recommendation = "Endpoint reachable; set XRPL_NATIVE_EXECUTE_URL to enable live transaction submission.";
    if (status.blocked) {
      recommendation = "Use interactive browser session that has passed Vercel checkpoint before live swap.";
    } else if (liveGateOpen) {
      recommendation = hasExecutor
        ? "Endpoint reachable and executor configured for XRPL live flow."
        : recommendation;
    } else {
      recommendation = "Endpoint reachable, but live gate is closed. Set DRY_RUN=false and LIVE_STAGE=canary/full.";
    }

    res.json({
      provider: "dex.anodos.finance",
      status,
      executor: {
        configured: hasExecutor,
        liveGateOpen,
        wallet: getXrplNativeExecutionWallet(),
        mockEnabled: config.XRPL_NATIVE_EXECUTE_MOCK_ENABLED,
        usesMock: config.XRPL_NATIVE_EXECUTE_URL.includes("/api/xrpl/executor/mock"),
        host: executorHost,
        hostAllowed: executorHost ? allowedHosts.includes(executorHost) : false,
        allowedHosts,
      },
      recommendation,
    });
  } catch (error) {
    res.status(500).json({
      provider: "dex.anodos.finance",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
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
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: message }
    ];

    const completion = await chatClient.chat.completions.create({
      model: config.OPENAI_MODEL,
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