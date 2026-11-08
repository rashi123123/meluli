import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The component lab: a plain browser page over mock data, for design polish only.
// It never runs inside Electron, never reaches IPC, and electron-vite's build does not include lab.html.
export default defineConfig({
  root: resolve("src/renderer"),
  cacheDir: resolve(".vite/lab"),
  resolve: {
    alias: {
      "@": resolve("src/renderer"),
      "@shared": resolve("src/shared"),
      "tw-animate-css": resolve("node_modules/tw-animate-css/dist/tw-animate.css")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5390,
    strictPort: true
  },
  build: { rollupOptions: { input: resolve("src/renderer/lab.html") } },
  plugins: [react(), tailwindcss()]
});
