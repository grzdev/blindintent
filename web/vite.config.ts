import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const lcdTarget = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
const apiTarget = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/lcd-testnet": {
        target: lcdTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lcd-testnet/, ""),
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/lcd-testnet": {
        target: lcdTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lcd-testnet/, ""),
      },
    },
  },
});
