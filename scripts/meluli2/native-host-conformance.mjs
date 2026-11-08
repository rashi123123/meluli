// Runs tests/native-host/conformance.ts in Node and in the native host runtime (meluli-js) and
// compares every check. SQLite checks run in the host only and are compared with fixed values.
//   node scripts/meluli2/native-host-conformance.mjs
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle-native-host.mjs";
import { cliHostSources } from "./native-host-sources.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, ".build/native-host");
mkdirSync(out, { recursive: true });

const swift = cliHostSources(root);
const cli = join(out, "meluli-js");
execFileSync("swiftc", ["-O", "-module-cache-path", join(out, "cache"), "-lsqlite3", ...swift, "-o", cli], { stdio: "inherit" });

const entry = join(root, "tests/native-host/conformance.ts");
await bundle(entry, join(out, "conformance.node.mjs"), { node: true });
await bundle(entry, join(out, "conformance.host.js"));

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    switch (req.url) {
      case "/json": res.writeHead(200, { "content-type": "application/json", "x-echo": req.headers["x-test"] ?? "" }); res.end(JSON.stringify({ ok: true, text: "שלום" })); break;
      case "/echo": res.writeHead(200, { "x-method": req.method }); res.end(body); break;
      case "/stream": {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        let sent = 0;
        const timer = setInterval(() => { res.write(Buffer.alloc(32 * 1024, 7)); if (++sent === 8) { clearInterval(timer); res.end(); } }, 5);
        break;
      }
      case "/redirect": res.writeHead(302, { location: "/json" }); res.end(); break;
      case "/slow": setTimeout(() => { if (!res.writableEnded) { res.writeHead(200); res.end("late"); } }, 2000); break;
      case "/drip": {
        res.writeHead(200);
        res.write("first");
        const timer = setInterval(() => { if (res.writableEnded || res.destroyed) return clearInterval(timer); res.write("."); }, 20);
        setTimeout(() => { clearInterval(timer); if (!res.writableEnded) res.end(); }, 3000);
        req.on("close", () => clearInterval(timer));
        break;
      }
      default: res.writeHead(404); res.end("missing");
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

function run(command, args, prefix) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env: { ...process.env, MELULI_CONFORMANCE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    const lines = new Map();
    let text = "";
    const take = (chunk) => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        let line = text.slice(0, index); text = text.slice(index + 1);
        if (prefix) { if (!line.startsWith(prefix)) { if (line.trim()) console.error(`  host: ${line}`); continue; } line = line.slice(prefix.length); }
        try { const { key, value } = JSON.parse(line); lines.set(key, JSON.stringify(value)); } catch { if (line.trim()) console.error(`  ${prefix ? "host" : "node"}: ${line}`); }
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, lines }); });
  });
}

const node = await run(process.execPath, [join(out, "conformance.node.mjs")], null);
const host = await run(cli, [join(out, "conformance.host.js")], "[js:log] ");
server.close();

// Checks where Node's own output is not the reference.
const EXPECTED = {
  "sqlite.basic": JSON.stringify(["wal", { changes: 1, lastInsertRowid: 1 }, { changes: 1, lastInsertRowid: 2 }, [{ name: "שלום" }, { name: "b" }], "שלום", 1.5, [1, 2], 1, null, 2,
    "SQLITE_CONSTRAINT_UNIQUE", "This statement does not return data. Use run() instead", "The supplied SQL string contains more than one statement", 7, ["id", "name", "score", "data", "flag"],
    "The database connection is not open"]),
  "sqlite.transaction": JSON.stringify([3, "stop", [1, 2, 3, 5, 7], false, { n: 5 }]),
  "sqlite.fts": JSON.stringify([{ text: "שלום עולם hello" }]),
  "sqlite.bigint": JSON.stringify([2 ** 40, 10])
};
// Known, accepted differences (documented in docs/DECISIONS.md, D20).
const ACCEPTED = new Set([]);

let failures = 0;
const keys = new Set([...node.lines.keys(), ...host.lines.keys(), ...Object.keys(EXPECTED)]);
keys.delete("done");
for (const key of keys) {
  const want = EXPECTED[key] ?? node.lines.get(key);
  const got = host.lines.get(key);
  if (want === got) continue;
  if (ACCEPTED.has(key)) { console.log(`ACCEPTED ${key}`); continue; }
  failures++;
  console.log(`DIFF ${key}\n  node: ${want}\n  host: ${got}`);
}
console.log(`node exit ${node.code} (${node.lines.size} checks), host exit ${host.code ?? host.signal} (${host.lines.size} checks), ${failures} differences`);
process.exit(failures || node.code || host.code ? 1 : 0);
