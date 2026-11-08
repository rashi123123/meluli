import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const electronNodeTarget = "node24";
const electronChromeTarget = "chrome156";
// The native app (scripts/meluli2/build-native-app.mjs) renders the same UI in WebKit.
const rendererTarget = process.env.MELULI_RENDERER_TARGET || electronChromeTarget;

const CONNECT_SRC = /connect-src [^;]*;/;

// The dev server needs localhost in the CSP; a built renderer talks to nothing.
export function lockConnectSrc(html: string): string {
  if (!CONNECT_SRC.test(html)) throw new Error("The renderer has no connect-src directive to narrow.");
  return html.replace(CONNECT_SRC, "connect-src 'self';");
}

const productionConnectSrc = {
  name: "production-connect-src",
  apply: "build" as const,
  transformIndexHtml: lockConnectSrc
};

// Only a test package, built on purpose with this mode, keeps the debug switches working.
const DEBUG_SWITCHES_MODE = "debug-switches";
// Set by scripts/package-release.sh. It turns on the update feed, in the main process and in Settings.
const OFFICIAL_BUILD = JSON.stringify(process.env.MELULI_OFFICIAL_BUILD === "1");

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __MELULI_ALLOW_DEBUG_SWITCHES__: JSON.stringify(mode === DEBUG_SWITCHES_MODE),
      __MELULI_OFFICIAL_BUILD__: OFFICIAL_BUILD
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
    define: {
      __MELULI_OFFICIAL_BUILD__: OFFICIAL_BUILD
    },
    build: {
      target: rendererTarget,
      // Off by default, as before; the native app's minified builds (--minify, --release) turn it on.
      minify: process.env.MELULI_RENDERER_MINIFY === "1" ? "esbuild" : false
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
