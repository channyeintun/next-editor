import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: {
      // Only workerd provides this module; tests construct Durable Objects
      // against a stand-in base class.
      "cloudflare:workers": fileURLToPath(
        new URL("./testing/cloudflareWorkers.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["infra/worker/**/*.{test,spec}.ts"],
  },
});
