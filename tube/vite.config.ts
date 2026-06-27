import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Cross-origin isolation so the same-origin editor iframe can boot WebContainer.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Where to proxy the editor's paths during local dev. Run the editor's built
  // preview (`bun run build && bun run preview` in the repo root → :4173) so its
  // hashed `/assets/*` don't collide with tube's dev module paths.
  const editorTarget = env.VITE_EDITOR_PROXY_TARGET || "http://localhost:4173";
  const editorPaths = ["/code", "/assets", "/fonts", "/logo.svg", "/logo.png"];

  return {
    plugins: [react(), tailwindcss()],
    build: {
      // Distinct from the editor's `/assets` so both can coexist on one origin.
      assetsDir: "gallery-assets",
    },
    server: {
      // Pinned so it doesn't collide with the editor preview server.
      port: 5174,
      strictPort: true,
      headers: crossOriginIsolation,
      proxy: Object.fromEntries(
        editorPaths.map((path) => [path, { target: editorTarget, changeOrigin: true }]),
      ),
    },
  };
});
