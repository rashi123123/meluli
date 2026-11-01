import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const executable = process.argv[2] ?? fileURLToPath(new URL("../resources/bin/whispercpp/meluli-asr-worker", import.meta.url));
const child = spawn(executable, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
let ready = false, healthy = false;
const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
child.stderr.resume();
try {
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.type === "ready") {
          assert.equal(message.protocolVersion, 2);
          assert.equal(message.backend, "whispercpp");
          if (process.platform === "darwin") assert.equal(message.diskIoPolicy, "standard");
          ready = true;
          child.stdin.write(JSON.stringify({ type: "health" }) + "\n");
        } else if (message.type === "health") {
          assert.equal(message.ok, true); healthy = true; child.stdin.end();
        } else throw new Error("Unexpected protocol response");
      } catch (error) { child.kill("SIGTERM"); reject(error); }
    });
    child.on("close", code => {
      if (code === 0 && ready && healthy) resolve();
      else reject(new Error("Native protocol smoke test failed"));
    });
  });
  console.log("PASS native whisper.cpp protocol 2: ready, health, clean EOF shutdown; no model loaded.");
} finally { clearTimeout(timeout); lines.close(); }
