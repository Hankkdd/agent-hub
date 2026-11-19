import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Loopback by default. Set AGENT_HUB_HOST to the tailscale IP to reach it from another tailnet device.
  // /api goes to the server, which stays on loopback in dev: only this dev server is exposed.
  server: {
    host: process.env.AGENT_HUB_HOST ?? "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.AGENT_HUB_PORT ?? "8787"}` } },
  },
});
