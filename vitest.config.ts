import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["tests/playwright/**", "node_modules/**"],
    setupFiles: ["tests/setup/env.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
