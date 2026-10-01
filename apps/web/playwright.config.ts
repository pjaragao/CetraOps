import { defineConfig, devices } from "@playwright/test";

/**
 * E2E contra o Supabase local (seed de desenvolvimento) e o app em http://localhost:3000.
 * Local: `supabase start`, `pnpm --filter @sie/web dev` (ou deixe o Playwright subir) e `pnpm --filter @sie/web e2e`.
 * CI: o job "E2E" sobe o Supabase, constrói o app e roda `pnpm --filter @sie/web e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,                    // os testes mexem no mesmo banco de desenvolvimento
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure", locale: "pt-BR", timezoneId: "America/Sao_Paulo" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } }, testIgnore: "**/mobile.e2e.ts" },
    { name: "celular", use: { ...devices["Pixel 7"] }, testMatch: "**/mobile.e2e.ts" },
  ],
  webServer: {
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
