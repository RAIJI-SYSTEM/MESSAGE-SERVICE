import { defineConfig } from "vitest/config";

/**
 * O serviço roda em Bun, mas o código só depende de `Bun.env` (coberto pelo
 * shim em test/setup.ts). O Vitest roda em Node para permitir a mesma
 * tecnologia de teste usada no FRONT-PWA.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 50,
        branches: 40,
      },
    },
  },
});
