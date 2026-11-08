// Bundles TypeScript for the native host runtime (D20): Node built-ins, better-sqlite3 and electron
// resolve to src/native-host, and the web and Node globals load before anything else.
//   node scripts/meluli2/bundle-native-host.mjs <entry.ts> <out.js> [--node]
// --node builds the same entry for plain Node instead (the conformance reference).
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const esbuild = require(join(root, "node_modules/.pnpm/node_modules/esbuild"));
// JavaScriptCore on the oldest system the app supports (macOS 13.3, LSMinimumSystemVersion): code is
// lowered to what Safari 16.4 parses, since that Mac may never have taken a newer Safari.
export const SAFARI_TARGET = "safari16.4";

const NODE_MODULES = {
  fs: "node/fs.ts", "fs/promises": "node/fs-promises.ts", path: "node/path.ts", os: "node/os.ts", url: "node/url.ts",
  crypto: "node/crypto.ts", child_process: "node/child_process.ts", events: "node/events.ts", stream: "node/stream.ts",
  string_decoder: "node/string_decoder.ts", worker_threads: "node/worker_threads.ts", util: "node/util.ts",
  perf_hooks: "node/perf_hooks.ts", module: "node/module.ts", buffer: "node/buffer.ts", readline: "node/readline.ts"
};

export async function bundle(entry, outfile, { node = false, define = {}, minify = false } = {}) {
  const host = join(root, "src/native-host");
  const plugin = {
    name: "native-host",
    setup(build) {
      build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        const name = args.path.replace(/^node:/, "");
        if (NODE_MODULES[name]) return { path: join(host, NODE_MODULES[name]) };
        if (args.path.startsWith("node:")) return { errors: [{ text: `node:${name} is not available in the native host` }] };
        return undefined;
      });
      build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: join(host, "sqlite.ts") }));
      build.onResolve({ filter: /^electron$/ }, () => ({ path: join(host, "electron/index.ts") }));
    }
  };
  const wrapper = node ? entry : join(root, ".build/native-host/entry-" + Buffer.from(entry).toString("hex").slice(-24) + ".ts");
  if (!node) {
    mkdirSync(dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, `import ${JSON.stringify(join(host, "globals.ts"))};\nimport ${JSON.stringify(resolve(entry))};\n`);
  }
  const result = await esbuild.build({
    entryPoints: [wrapper],
    outfile,
    bundle: true,
    format: node ? "esm" : "iife",
    platform: node ? "node" : "neutral",
    mainFields: ["module", "main"],
    conditions: node ? [] : ["import", "default"],
    target: node ? "node22" : SAFARI_TARGET,
    tsconfig: join(root, "tsconfig.node.json"),
    plugins: node ? [] : [plugin],
    external: node ? ["better-sqlite3", "electron"] : [],
    // In the app, import.meta.url is the main bundle's own file URL, which the Swift host sets as
    // __meluliMainUrl before it runs the bundle; debug launch switches stay refused.
    define: node ? define : { "import.meta.url": "__meluliMainUrl", __MELULI_ALLOW_DEBUG_SWITCHES__: "false", ...define },
    // A release carries no source maps: they hold build paths and the whole source.
    sourcemap: minify ? false : "linked",
    minify,
    legalComments: "none",
    logLevel: "warning",
    metafile: true
  });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [entry, out, ...flags] = process.argv.slice(2);
  if (!entry || !out) { console.error("usage: bundle-native-host.mjs <entry.ts> <out.js> [--node] [--minify]"); process.exit(64); }
  const result = await bundle(resolve(entry), resolve(out), { node: flags.includes("--node"), minify: flags.includes("--minify") });
  const bytes = Object.values(result.metafile.outputs).reduce((sum, item) => sum + item.bytes, 0);
  console.log(`${out} ${(bytes / 1024).toFixed(0)} KiB`);
}
