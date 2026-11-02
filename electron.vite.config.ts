import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const electronNodeTarget = "node24";
const electronChromeTarget = "chrome156";

// The dev server needs localhost in the CSP; a built renderer talks to nothing.
const productionConnectSrc = {
  name: "production-connect-src",
  apply: "build" as const,
  transformIndexHtml: (html: string) => html.replace(/connect-src [^;]*;/, "connect-src 'self';")
};

// Only a test package, built on purpose with this mode, keeps the debug switches working.
const DEBUG_SWITCHES_MODE = "debug-switches";

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __MELULI_ALLOW_DEBUG_SWITCHES__: JSON.stringify(mode === DEBUG_SWITCHES_MODE)
    },
    build: {
      target: electronNodeTarget
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main")
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      target: electronNodeTarget,
      rollupOptions: {
        output: {
          format: "cjs"
        }
      }
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared")
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    build: {
      target: electronChromeTarget
    },
    cacheDir: resolve(".vite/renderer"),
    resolve: {
      alias: {
        "@": resolve("src/renderer"),
        "@shared": resolve("src/shared"),
        "tw-animate-css": resolve("node_modules/tw-animate-css/dist/tw-animate.css")
      }
    },
    optimizeDeps: {
      force: true,
      include: [
        "@base-ui/react/button",
        "@base-ui/react/input",
        "@base-ui/react/progress",
        "@base-ui/react/scroll-area",
        "@base-ui/react/separator",
        "@base-ui/react/switch",
        "@base-ui/react/merge-props",
        "@base-ui/react/use-render"
      ]
    },
    plugins: [react(), tailwindcss(), productionConnectSrc]
  }
}));
