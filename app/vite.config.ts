import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The NEAR Auth SDK and near-api-js expect Node's Buffer in the browser.
// The /api proxy keeps the browser on one origin in development.
export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
      },
    },
  },
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
});
