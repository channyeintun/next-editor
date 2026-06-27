import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Pinned so it doesn't collide with the editor dev server (default 5173).
    port: 5174,
    strictPort: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
});
