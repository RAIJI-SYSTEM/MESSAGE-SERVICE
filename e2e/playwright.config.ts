import { defineConfig } from "@playwright/test";

/**
 * E2E de sistema do MESSAGE-SERVICE.
 *
 * O chat não tem UI: o Playwright usa APIRequestContext contra o Kong.
 * O fluxo de integração também cria uma carona no monólito para validar
 * o evento RabbitMQ que cria o grupo no chat.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.KONG_URL ?? "http://localhost:8000",
    extraHTTPHeaders: { Accept: "application/json" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
