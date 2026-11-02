import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const executable = require("electron");
const watch = process.argv.includes("--watch");
const args = process.argv.slice(2).filter(arg => arg !== "--watch");
const child = spawn(executable, [require.resolve("vitest/vitest.mjs"), ...(watch ? [] : ["run"]), ...args], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" }
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
