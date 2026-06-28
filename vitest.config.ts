import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // Pass --experimental-sqlite so node:sqlite is available in test doubles
    // (Node 22.5+ built-in; flag suppresses the experimental warning in older 22.x).
    poolOptions: {
      forks: {
        execArgv: ["--experimental-sqlite"],
      },
      threads: {
        execArgv: ["--experimental-sqlite"],
      },
    },
  },
});
