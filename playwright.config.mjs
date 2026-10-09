import { defineConfig } from "@playwright/test";

const remoteBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  use: { baseURL: remoteBaseURL || "http://127.0.0.1:4173", headless: true },
  webServer: remoteBaseURL ? undefined : {
    command: "python -m http.server 4173 --bind 127.0.0.1",
    url: "http://127.0.0.1:4173/sim/",
    reuseExistingServer: true
  }
});
