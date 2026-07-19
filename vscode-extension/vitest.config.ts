import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      "test/artifact/**/*.test.ts",
      "test/recovery/**/*.test.ts",
      "test/webview/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
