import { chromium } from "@playwright/test";

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

(async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const EXTENSION_PATH = path.resolve(__dirname, "../extensions/metamask");
  const PROFILE_DIR = path.resolve(__dirname, "../data/browser-profile-test");
  // Use Playwright's Chrome for Testing — branded Google Chrome blocks --load-extension
  const CHROMIUM_BIN = path.join(
    os.homedir(),
    ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
  );

  console.log("Using browser:", CHROMIUM_BIN);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: CHROMIUM_BIN,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    viewport: { width: 1200, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"]
  });

  try {
    // MV3: wait for service worker
    let loaded = false;
    for (let i = 0; i < 10; i++) {
      const sw = context.serviceWorkers();
      loaded = sw.some(w => w.url().includes("chrome-extension"));
      if (loaded) break;
      await Promise.race([
        context.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => null),
        new Promise(r => setTimeout(r, 2000)),
      ]);
    }
    console.log("MetaMask extension loaded:", loaded);
    for (const page of context.pages()) {
      console.log("Page URL:", page.url());
    }
    for (const sw of context.serviceWorkers()) {
      console.log("ServiceWorker URL:", sw.url());
    }
    await new Promise(r => setTimeout(r, 3000));
  } finally {
    await context.close();
  }
})();
