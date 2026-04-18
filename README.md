# OKX Agentic Trading Bot

Aplikasi ini adalah backend trading bot berbasis AI yang:

- mengambil quote beli dan jual dari OKX DEX API,
- meminta model AI memutuskan `buy`, `sell`, atau `hold`,
- dapat mengeksekusi swap lewat wallet EVM lokal atau `OKX Agentic Wallet` bila `DRY_RUN=false`.

Default desainnya aman:

- `DRY_RUN=true`
- keputusan AI wajib berbentuk JSON tervalidasi
- ada batas nilai order via env

## Fitur

- API HTTP untuk menjalankan bot per request
- CLI untuk eksekusi cepat dari terminal
- OpenAI-compatible LLM backend, jadi bisa pakai Ollama, OpenAI, atau gateway lain
- Wrapper OKX DEX quote + swap
- Execution provider pluggable: local EVM wallet atau OKX Agentic Wallet
- Baseline strategy konservatif sebagai risk gate sebelum keputusan AI dipakai
- Scanner BNB Chain untuk memetakan sampai 100 coin termurah yang masih punya holder tinggi, likuiditas tinggi, dan market cap besar
- Scheduler otomatis tiap 5 menit dengan notifikasi Telegram
- Export kandidat BEP20 ke JSON dan CSV untuk input algoritma

## Instalasi

```bash
cd /home/lasbonai/Desktop/lasbonai/okx-agentic-bot
npm install
cp .env.example .env
```

Isi minimal `.env`:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `EXECUTION_WALLET_ADDRESS`

Opsional untuk mode fallback CLI lokal:

- `ONCHAINOS_BIN` bila binary `onchainos` tidak ada di `PATH`

Untuk mode API langsung ke OKX DEX, tambahkan juga:

- `OKX_ACCESS_KEY`
- `OKX_SECRET_KEY`
- `OKX_PASSPHRASE`
- `OKX_PROJECT_ID` bila akun Anda memerlukannya

Pilih salah satu mode eksekusi:

### Mode 1: Local wallet

- `EXECUTION_PROVIDER=local-wallet`
- `EXECUTION_WALLET_PRIVATE_KEY`
- `EXECUTION_WALLET_ADDRESS`
- `EVM_RPC_URL`

### Mode 2: OKX Agentic Wallet

- `EXECUTION_PROVIDER=okx-agentic-wallet`
- `OKX_AGENTIC_WALLET_EXECUTE_URL`
- `OKX_AGENTIC_WALLET_API_KEY`
- `OKX_AGENTIC_WALLET_ID`
- `OKX_AGENTIC_SUB_WALLET_ID` opsional bila Anda memakai sub-wallet

Catatan penting:

- Saat ini kode bot sudah mendukung arsitektur `OKX Agentic Wallet`, tetapi payload eksekusi ke endpoint signing/submit mungkin perlu Anda sesuaikan dengan endpoint resmi/akses beta yang Anda miliki dari OKX.
- Jika kredensial API OKX DEX belum tersedia, bot akan fallback ke `onchainos` CLI untuk quote dan unsigned swap build. Ini cocok untuk dry-run lokal dengan wallet Agentic yang sudah login.
- Jadi bagian AI, quote, risk gate, dan orchestration sudah siap; bagian `execution adapter` tinggal diselaraskan dengan kontrak API OKX Agentic Wallet yang tersedia di akun Anda.

## Menjalankan API

```bash
npm run dev
```

API aktif di `http://127.0.0.1:8787`.

Saat server hidup, scheduler juga bisa berjalan otomatis setiap 5 menit bila `SCHEDULE_ENABLED=true`.

## Integrasi Dengan AI Agent Docker Lokal

Jika Anda sudah punya stack lokal (`openclaw` / `ollama`) di Docker, jalankan integrasi otomatis:

```bash
npm run integrate:local-agent
```

Script di atas akan:

- deteksi endpoint model lokal (`http://127.0.0.1:3001/v1` atau `http://127.0.0.1:11435/v1`)
- update `.env` agar bot memakai endpoint yang aktif
- paksa mode aman (`LIVE_STAGE=dry-run`, `DRY_RUN=true`)
- build + preflight otomatis

Health check cepat:

```bash
npm run health:local-agent
```

Validasi penuh satu perintah:

```bash
npm run validate:full
```

Mode cepat (lewati export + telegram):

```bash
npm run validate:quick
```

Mode ketat (tambahan assertion confidence/decisionSource):

```bash
npm run validate:strict
```

Urutan yang dijalankan otomatis:

- build
- live preflight
- health check layanan
- skenario bullish dry-run
- skenario safety dry-run
- export candidates
- telegram test

Output akhir juga menampilkan ringkasan `SUCCESS/FAILED` per tahap seperti checklist QA.

Validator juga melakukan assertion semantik otomatis:

- `functional-bullish`: baseline harus `buy`, decision tidak boleh `hold`, dan `execution.mode=preview`
- `functional-safety`: baseline dan decision harus `hold`, tanpa objek execution

Setiap run menyimpan report ke:

- `data/validation-reports/validate-full-YYYYMMDD-HHMMSS.log`

Di mode `quick`, tahap `candidate-export` dan `telegram` akan ditandai `SKIP`.

Jika endpoint model belum aktif, start stack dari root workspace Anda dulu:

```bash
docker compose --env-file .env up -d
```

## Integrasi CPU + GPU NVIDIA (Hybrid Compute)

Profil komputasi sekarang bisa di-apply otomatis agar seluruh pipeline bot memanfaatkan CPU host + GPU NVIDIA lewat stack AI lokal.

Apply profil:

```bash
npm run compute:apply
```

Cek status integrasi:

```bash
npm run compute:status
```

Yang diatur oleh profil ini:

- `BOT_UV_THREADPOOL_SIZE` untuk worker thread Node.js bot
- `OPENCLAW_UV_THREADPOOL_SIZE` untuk OpenClaw runtime
- `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE`
- `OLLAMA_FLASH_ATTENTION` aktif otomatis jika GPU NVIDIA terdeteksi

Autostart terintegrasi (`npm run autostart:integrated`) juga akan menjalankan `compute:apply` terlebih dulu.

## Autostart VSCode + Browser App (PWA Style)

Autostart terstruktur tersedia via:

- script startup terintegrasi: `npm run autostart:integrated`
- task VSCode auto-run saat folder dibuka: `.vscode/tasks.json`

Urutan autostart:

1. jalankan `integrate:local-agent`
2. pastikan bot aktif di `:8787`
3. buka browser mode app ke URL bot (`AUTOSTART_PWA_URL`)

Konfigurasi env autostart:

- `AUTOSTART_OPEN_BROWSER_PWA=true|false`
- `AUTOSTART_PWA_URL=http://127.0.0.1:8787`

Catatan:

- Browser app mode memprioritaskan `google-chrome`, `chromium-browser`, `chromium`, lalu fallback ke `xdg-open`.
- Jika docker permission belum aktif di shell saat VSCode dibuka, autostart akan gagal pada tahap integrasi. Setelah group `docker` aktif, autostart akan berjalan normal.

## Cloudflare Tunnel (Akses Dari Mana Saja)

Mode ini bersifat non-destruktif:

- tidak menghentikan tunnel lain yang sudah berjalan
- hanya menambah tunnel baru untuk `okx-agentic-bot` jika belum ada

Jalankan:

```bash
npm run cloudflare:tunnel:start
```

Cek status dan URL publik:

```bash
npm run cloudflare:tunnel:status
```

Konfigurasi target lokal:

- `CLOUDFLARE_TUNNEL_TARGET_URL=http://127.0.0.1:8787`

Catatan:

- Jika binary `cloudflared` tidak tersedia, script akan fallback ke container Docker `cloudflare/cloudflared`.
- Untuk mode domain custom (bukan `trycloudflare.com`), tunnel named + DNS route perlu di Cloudflare account Anda.

## Menjalankan CLI

```bash
npm run cli -- run --market-context "BTC sideways, risk-off"
```

CLI memakai default env:

- `DEFAULT_CHAIN_ID`
- `DEFAULT_BASE_TOKEN_ADDRESS`
- `DEFAULT_QUOTE_TOKEN_ADDRESS`
- `DEFAULT_BUY_AMOUNT`
- `DEFAULT_SELL_AMOUNT`

## Live Mode Bertahap (Guardrail)

Gunakan mode bertahap ini sebelum `DRY_RUN=false`:

- Stage 1 (`LIVE_STAGE=dry-run`, `DRY_RUN=true`)
- Stage 2 (`LIVE_STAGE=canary`, `DRY_RUN=false`)
- Stage 3 (`LIVE_STAGE=full`, `DRY_RUN=false`)

Preflight checker:

```bash
npm run live:preflight
```

Guardrail wajib saat live (`DRY_RUN=false`):

- `LIVE_STAGE` harus `canary` atau `full`
- `MAX_BUY_AMOUNT` wajib diisi
- `MAX_SELL_AMOUNT` wajib diisi
- `DEFAULT_BUY_AMOUNT <= MAX_BUY_AMOUNT`
- `DEFAULT_SELL_AMOUNT <= MAX_SELL_AMOUNT`
- `MAX_CONFIDENCE_TO_EXECUTE <= 0.8`

Jika salah satu guardrail gagal, bot akan menolak eksekusi real.

## Memetakan 100 coin murah berkualitas di BNB Chain

```bash
npm run scan:bnb-cheap-quality
```

Default scanner:

- chain: `bnb`
- sort: harga termurah dulu
- `holders >= 10,000`
- `liquidity >= $1,000,000`
- `marketCap >= $50,000,000`

Threshold dapat diubah:

```bash
npm run scan:bnb-cheap-quality -- --holders-min 25000 --liquidity-min 5000000 --market-cap-min 100000000 --limit 100
```

## Notifikasi Telegram

Bot akan mencoba mengirim hasil evaluasi terjadwal ke Telegram setiap 5 menit.

Isi env berikut:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Catatan penting:

- Username pribadi seperti `@lasbon_88` tidak cukup untuk Bot API Telegram private chat. Anda tetap perlu `TELEGRAM_CHAT_ID` numerik.
- Biasanya alurnya: buat bot dengan BotFather, kirim `/start` ke bot itu dari akun Anda, lalu ambil `chat_id` dari update bot atau helper lain.

Mode scheduler default sekarang memakai kandidat scan BEP20. Telegram hanya mengirim kandidat yang lolos filter (jika ada).

Konfigurasi kandidat scan lewat env:

- `CANDIDATE_HOLDERS_MIN`
- `CANDIDATE_LIQ_MIN_IDR`
- `CANDIDATE_MC_MIN_IDR`
- `CANDIDATE_FDV_MIN_IDR`
- `CANDIDATE_AUTO_RELAX_ENABLED` untuk auto fallback jika mode strict menghasilkan 0 kandidat
- `CANDIDATE_RELAX_HOLDERS_MIN`
- `CANDIDATE_RELAX_MC_MIN_IDR`
- `CANDIDATE_RELAX_FDV_MIN_IDR`
- `CANDIDATE_LIMIT`
- `CANDIDATE_REQUIRE_EXPLICIT_FDV`
- `CANDIDATE_ALLOWLIST_ADDRESSES` (opsional, comma-separated contract address untuk lock daftar token)
- `CANDIDATE_ALLOWLIST_FALLBACK_TO_TOP` (default `true`) agar scanner tetap output saat token allowlist tidak muncul di hasil `hot-tokens`
- `CANDIDATE_SCAN_MAX_ATTEMPTS` dan `CANDIDATE_SCAN_RETRY_DELAY_MS` untuk retry bertahap saat screener intermiten
- `CANDIDATE_HISTORY_ENABLED` dan `CANDIDATE_HISTORY_KEEP` untuk snapshot historis otomatis

Catatan mode scan:

- Default `CANDIDATE_FDV_MIN_IDR=0` agar pipeline tidak terlalu ketat saat data FDV upstream tidak stabil.
- Jika `CANDIDATE_AUTO_RELAX_ENABLED=true` dan hasil strict kosong, scanner otomatis turun ke mode relaxed.
- Jika allowlist aktif tetapi tidak ada match, mode `fallback-top` dipakai (bisa dimatikan lewat `CANDIDATE_ALLOWLIST_FALLBACK_TO_TOP=false`).
- Pesan Telegram kandidat menampilkan mode scan (`strict` / `relaxed` / `fallback-top`) untuk transparansi.

Helper command:

```bash
npm run telegram:updates
```

Command di atas menampilkan update terbaru beserta `chatId` yang bisa dimasukkan ke `TELEGRAM_CHAT_ID`.

Setelah `TELEGRAM_CHAT_ID` terisi, uji kirim manual:

```bash
npm run telegram:test -- "Test from OKX scheduler"
```

## Export Kandidat untuk Algoritma

Jalankan:

```bash
npm run export:candidates
```

Output file:

- `data/bep20-candidates.latest.json`
- `data/bep20-candidates.latest.csv`
- `data/history/bep20-candidates.<timestamp>.json`
- `data/history/bep20-candidates.<timestamp>.csv`

## Endpoint API

`POST /api/bot/run`

Contoh payload:

```json
{
  "chainId": "1",
  "walletAddress": "0xYourWallet",
  "baseTokenAddress": "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "quoteTokenAddress": "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2",
  "buyAmount": "1000000",
  "sellAmount": "1000000000000000",
  "slippage": "0.5",
  "marketContext": "ETH oversold on 4h, funding neutral, CPI besok"
}
```

Respons berisi:

- quote beli
- quote jual
- keputusan AI
- hasil eksekusi atau preview transaksi

## Cara kerja

1. Bot mengambil quote `quote -> base` untuk skenario beli.
2. Bot mengambil quote `base -> quote` untuk skenario jual.
3. Baseline strategy mengecek fee ratio, price impact, dan market context untuk memblokir setup yang buruk.
4. Jika baseline tidak memblokir, AI menerima ringkasan quote dan market context.
5. AI mengembalikan keputusan JSON tervalidasi.
6. Bila keputusan bukan `hold` dan `DRY_RUN=false`, bot meminta swap transaction dari OKX lalu mengirim transaksi via RPC wallet.

Jika `EXECUTION_PROVIDER=okx-agentic-wallet`, langkah 5 berubah menjadi:

6. Bot meminta transaksi swap dari OKX DEX.
7. Bot mengirim payload transaksi itu ke execution endpoint Agentic Wallet.
8. Agentic Wallet yang menandatangani dan men-submit transaksi dari lingkungan aman.

## Catatan penting

- Ini adalah fondasi aplikasi, bukan strategi profit yang dijamin.
- Jalankan `DRY_RUN=true` dulu sampai quote, route, dan signer Anda tervalidasi.
- Endpoint OKX dapat berubah. Bila respons API OKX berbeda dari parser saat ini, sesuaikan mapping di `src/okx-client.ts`.
- Untuk mode Agentic Wallet, sesuaikan adapter di `src/executors/okx-agentic-wallet.ts` dengan endpoint resmi yang Anda dapat dari OKX.
- Gunakan wallet khusus bot, bukan wallet utama Anda.