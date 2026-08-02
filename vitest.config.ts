import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    // 網羅フィクスチャの照合は 100 件超のアーカイブを展開するため長めに取る
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
