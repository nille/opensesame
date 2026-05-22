import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Vite default port 5173 matches the BFF's CORS allow-list (slice 7,
// ADR-0021). The BFF runs on 127.0.0.1:3000.
export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
