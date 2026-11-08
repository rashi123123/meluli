// The same checks run in Node and in the native host; scripts/meluli2/native-host-conformance.mjs
// compares the two outputs line by line. Each check prints {"key", "value"}; values must not hold
// paths, times or ids that differ between runs.
import { Buffer } from "node:buffer";
import { EventEmitter, once } from "node:events";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync, openSync, closeSync, constants } from "node:fs";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile, mkdir, copyFile, lstat, statfs, access } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, format, pathToFileURL } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

const port = Number(process.env.MELULI_CONFORMANCE_PORT ?? 0);
const results: string[] = [];
function report(key: string, value: unknown) {
  const line = JSON.stringify({ key, value }, (_k, item) => (item instanceof Uint8Array ? `bytes:${Buffer.from(item).toString("hex")}` : typeof item === "bigint" ? `${item}n` : item));
  results.push(line);
  console.log(line);
}
async function check(key: string, run: () => unknown | Promise<unknown>) {
  try { report(key, await run()); }
  catch (error) {
    const e = error as Error & { code?: unknown; name?: string };
    report(key, { threw: e?.name ?? typeof error, code: e?.code ?? null, message: String(e?.message ?? error).replace(/'[^']*'/g, "'…'").slice(0, 80) });
  }
}
const errorShape = (error: unknown) => { const e = error as { code?: unknown; syscall?: unknown; errno?: unknown }; return { code: e.code, syscall: e.syscall, errno: e.errno }; };

async function main() {
  // Buffer and text
  await check("buffer.utf8", () => Buffer.from("שלום, world ✓").toString("hex"));
  await check("buffer.base64", () => [Buffer.from("מלולי").toString("base64"), Buffer.from("8J+YgA==", "base64").toString(), Buffer.from("_-8", "base64url").toString("hex")]);
  await check("buffer.hex", () => [Buffer.from("00ff7a", "hex").toJSON(), Buffer.from("zz", "hex").length]);
  await check("buffer.latin1", () => [Buffer.from("é", "latin1").toString("hex"), Buffer.from([0xe9]).toString("latin1")]);
  await check("buffer.accessors", () => {
    const b = Buffer.alloc(16);
    const ends = [b.writeUInt32LE(0xdeadbeef, 0), b.writeUInt16LE(0xbeef, 4), b.writeInt16LE(-2, 6), b.writeInt32LE(-5, 8), b.writeFloatLE(1.5, 12)];
    return { ends, hex: b.toString("hex"), back: [b.readUInt32LE(0), b.readUInt16LE(4), b.readInt16LE(6), b.readInt32LE(8), b.readFloatLE(12), b.readUInt32BE(0)] };
  });
  await check("buffer.write", () => { const b = Buffer.alloc(8); const n = b.write("RIFF", 0); b.write("WAVEXX", 4, 3); return [n, b.toString("latin1")]; });
  await check("buffer.concat-slice", () => {
    const joined = Buffer.concat([Buffer.from("ab"), new Uint8Array([99, 100]), Buffer.from("ef")]);
    const part = joined.subarray(1, 4);
    part[0] = 0x5a;
    return [joined.toString(), part.toString(), Buffer.isBuffer(part), joined.slice(-2).toString(), Buffer.concat([Buffer.from("abc")], 2).toString(), Buffer.byteLength("שלום")];
  });
  await check("buffer.from-arraybuffer", () => { const ab = new ArrayBuffer(4); new Uint8Array(ab)[1] = 7; const b = Buffer.from(ab, 1, 2); b[1] = 9; return [Array.from(b), Array.from(new Uint8Array(ab))]; });
  await check("buffer.compare", () => [Buffer.compare(Buffer.from("a"), Buffer.from("b")), Buffer.from("ab").equals(Buffer.from("ab")), Buffer.alloc(3, "ab").toString(), Buffer.alloc(2, 1).toJSON().data]);
  await check("textcodec.stream", () => {
    const bytes = new TextEncoder().encode("א😀ב");
    const decoder = new TextDecoder();
    const parts = [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)].map((part) => decoder.decode(part, { stream: true }));
    return [Array.from(bytes).length, parts, decoder.decode()];
  });
  await check("textcodec.bom", () => [new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), new TextDecoder().decode(new Uint8Array([0xff, 0x61]))]);
  await check("string-decoder", () => {
    const decoder = new StringDecoder("utf8");
    const bytes = Buffer.from("ש😀\n");
    return [decoder.write(bytes.subarray(0, 1)), decoder.write(bytes.subarray(1, 3)), decoder.write(bytes.subarray(3)), decoder.end()];
  });
  await check("atob-btoa", () => [btoa("hello"), atob("aGVsbG8="), btoa(String.fromCharCode(255, 0))]);
  await check("structuredClone", () => { const source = { a: [1, { b: new Date(0) }], m: new Map([["k", 1]]), u: new Uint8Array([1, 2]) }; const copy = structuredClone(source); return [copy !== source, copy.a[1] !== source.a[1], (copy.a[1] as { b: Date }).b.getTime(), [...copy.m], Array.from(copy.u)]; });

  // URL and path
  const urls: [string, string?][] = [
    ["https://User:Pw@Example.COM:443/a/./b/../c?q=1&r=%20x#frag"], ["http://localhost:8080"], ["https://api.openai.com/v1/audio/transcriptions"],
    ["../x?y", "https://example.com/a/b/c"], ["/root", "https://example.com/a/b"], ["file:///Users/example/My%20Folder/a.wav"],
    ["meluli://app/index.html#/history"], ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s"], ["https://youtu.be/abc?si=x"],
    ["not a url"], ["https://example.com/שלום?ש=ל"], ["mailto:someone@example.com"], ["https://example.com:99999"]
  ];
  for (const [input, base] of urls) {
    await check(`url:${input}|${base ?? ""}`, () => { const u = new URL(input, base); return [u.href, u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin]; });
  }
  await check("url.searchParams", () => {
    const u = new URL("https://x.test/p?a=1&b=two+words&a=3");
    const p = u.searchParams;
    const before = [p.get("a"), p.getAll("a"), p.get("b"), p.has("c"), [...p.keys()]];
    p.set("a", "9"); p.append("c", "ש ל&"); p.delete("b");
    return [before, u.search, u.href, new URLSearchParams({ x: "1", y: "a b" }).toString(), String(new URLSearchParams("?z=%2B+1"))];
  });
  await check("url.file", () => [fileURLToPath("file:///Users/example/My%20Folder/%D7%A9.wav"), pathToFileURL("/tmp/a b/ש#.txt").href,
    format({ protocol: "file:", slashes: true, pathname: "/Applications/Meluli.app/Contents/Resources/app/out/renderer/index.html" })]);
  await check("url.canParse", () => [URL.canParse("https://a.b"), URL.canParse("nope"), URL.canParse("/x", "https://a.b")]);
  await check("path", () => [
    join("/a", "b", "../c", "./d/"), join("a", "", "b"), join(""), normalize("/a//b/../c/."), normalize("./"), normalize("a/../.."),
    dirname("/a/b/c"), dirname("/a"), dirname("a"), dirname("/a/b/"), basename("/a/b.txt"), basename("/a/b.txt", ".txt"), basename("/a/b/"),
    extname("x.tar.gz"), extname(".bashrc"), extname("a."), isAbsolute("/x"), isAbsolute("x"), relative("/a/b/c", "/a/d"), relative("/a", "/a"),
    resolve("/a/b", "../c"), resolve("/a", "/b", "c"), parse("/home/u/file.txt"), parse("file"), sep
  ]);
  await check("os", () => [homedir() === process.env.HOME, tmpdir().endsWith("/") === false, isAbsolute(tmpdir())]);

  // Events and timers
  await check("events", async () => {
    const emitter = new EventEmitter();
    const seen: string[] = [];
    emitter.on("x", (v) => seen.push(`on:${v}`));
    emitter.once("x", (v) => seen.push(`once:${v}`));
    emitter.prependListener("x", (v) => seen.push(`first:${v}`));
    emitter.emit("x", 1); emitter.emit("x", 2);
    let threw = "";
    try { emitter.emit("error", new Error("boom")); } catch (error) { threw = (error as Error).message; }
    setTimeout(() => emitter.emit("later", "v"), 1);
    const [value] = await once(emitter, "later");
    return [seen, emitter.listenerCount("x"), threw, value];
  });
  await check("timers.order", async () => {
    const order: string[] = [];
    await new Promise<void>((done) => {
      setTimeout(() => { order.push("timeout"); }, 0);
      setImmediate(() => order.push("immediate"));
      Promise.resolve().then(() => order.push("promise"));
      queueMicrotask(() => order.push("microtask"));
      process.nextTick(() => order.push("tick"));
      order.push("sync");
      setTimeout(done, 20);
    });
    // Node runs nextTick before promises; the host folds it into the microtask queue.
    return [order[0], order.filter((item) => item !== "tick").slice(0, 3), order.includes("tick"), order.slice(-2).sort()];
  });
  await check("timers.clear", async () => {
    let fired = 0;
    const a = setTimeout(() => fired++, 5); clearTimeout(a);
    const b = setInterval(() => { fired += 10; if (fired >= 30) clearInterval(b); }, 2);
    await new Promise((r) => setTimeout(r, 60));
    const c = setTimeout(() => fired += 100, 5); c.unref(); c.ref(); clearTimeout(c);
    return [fired, typeof a.hasRef];
  });
  await check("abort", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    controller.signal.addEventListener("abort", () => seen.push("listener"));
    controller.signal.onabort = () => seen.push("property");
    controller.abort();
    controller.abort();
    const reason = controller.signal.reason as DOMException;
    const timed = AbortSignal.timeout(5);
    await new Promise((r) => setTimeout(r, 30));
    const any = AbortSignal.any([new AbortController().signal, AbortSignal.abort("why")]);
    let thrown = "";
    try { any.throwIfAborted(); } catch (error) { thrown = String(error); }
    return [seen.sort(), controller.signal.aborted, reason.name, reason instanceof Error, (timed.reason as DOMException).name, any.aborted, thrown];
  });
  await check("performance", () => { const a = performance.now(); const b = performance.now(); return [typeof a, b >= a, a < 120000]; });
  await check("hrtime", () => { const t = process.hrtime.bigint(); const [s, n] = process.hrtime(); return [typeof t, typeof s, n < 1e9]; });

  // Crypto
  await check("crypto.hash", () => [createHash("sha256").update("abc").digest("hex"), createHash("sha256").update(Buffer.from("a")).update("bc").digest("base64"),
    createHash("sha1").update("").digest("hex"), createHash("md5").update("שלום", "utf8").digest("hex")]);
  await check("crypto.random", () => [/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(randomUUID()), randomBytes(12).length, Buffer.isBuffer(randomBytes(2)),
    globalThis.crypto.getRandomValues(new Uint8Array(4)).length, /^[0-9a-f-]{36}$/.test(globalThis.crypto.randomUUID())]);

  // File system
  const base = await mkdtemp(join(realpathSync(tmpdir()), "meluli-conformance-"));
  const rel = (path: string) => path.replace(base, "<base>");
  try {
    await check("fs.write-read", async () => {
      const file = join(base, "a.txt");
      await writeFile(file, "שלום\n", "utf8");
      await writeFile(join(base, "b.bin"), new Uint8Array([1, 2, 3]));
      appendFileSync(file, "more");
      writeFileSync(join(base, "c.txt"), "sync");
      return [await readFile(file, "utf8"), (await readFile(join(base, "b.bin"))).toJSON().data, readFileSync(join(base, "c.txt"), "utf8"),
        readFileSync(file).length, Buffer.isBuffer(readFileSync(file)), existsSync(file), existsSync(join(base, "none"))];
    });
    await check("fs.stat", async () => {
      const s = await stat(join(base, "a.txt"));
      const d = statSync(base);
      const l = await lstat(join(base, "a.txt"));
      return [s.size, s.isFile(), s.isDirectory(), d.isDirectory(), l.isSymbolicLink(), s.mtime instanceof Date, s.mtimeMs > 1e12, statSync(join(base, "nope"), { throwIfNoEntry: false }) ?? null, (await statfs(base)).bsize > 0];
    });
    await check("fs.stat.bigint", async () => {
      // model-integrity.ts fingerprints the model with these exact fields.
      const path = join(base, "a.txt");
      const big = await lstat(path, { bigint: true });
      const plain = await lstat(path);
      const sync = statSync(path, { bigint: true });
      return [typeof big.size, big.size === BigInt(plain.size), big.ino === BigInt(plain.ino), big.dev === BigInt(plain.dev), big.isFile(),
        typeof big.mtimeNs, big.mtimeNs / 1_000_000n === big.mtimeMs, Number(big.mtimeMs) === Math.floor(plain.mtimeMs), big.ctimeNs > 0n,
        sync?.mtimeNs === big.mtimeNs, big.mtime instanceof Date];
    });
    await check("fs.handle.chmod", async () => {
      // subtitle-export.service.ts: open with 0o600, then chmod the handle, then write.
      const path = join(base, "export.txt");
      await writeFile(path, "old content", { mode: 0o644 });
      const handle = await open(path, "w", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile("שלום", "utf8");
      await handle.close();
      return [(await stat(path)).mode & 0o777, await readFile(path, "utf8")];
    });
    await check("fs.rm.retries", async () => {
      const tree = join(base, "tree");
      await mkdir(join(tree, "a/b"), { recursive: true });
      await writeFile(join(tree, "a/b/c.txt"), "x");
      await rm(tree, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
      await rm(join(base, "never-there"), { recursive: true, force: true, maxRetries: 2 });
      return [existsSync(tree)];
    });
    await check("fs.rm.links", async () => {
      // A link inside the tree is removed as a link: the folder and file it points to stay.
      const outside = join(base, "outside");
      const tree = join(base, "linked");
      await mkdir(join(outside, "keep"), { recursive: true });
      await writeFile(join(outside, "keep/file.txt"), "kept");
      await mkdir(join(tree, "inner"), { recursive: true });
      await promisify(execFile)("/bin/ln", ["-s", outside, join(tree, "inner/to-folder")]);
      await promisify(execFile)("/bin/ln", ["-s", join(outside, "keep/file.txt"), join(tree, "to-file")]);
      await rm(tree, { recursive: true, force: true });
      const result = [existsSync(tree), readFileSync(join(outside, "keep/file.txt"), "utf8"), readdirSync(outside)];
      // A link given as the top path is removed itself.
      await promisify(execFile)("/bin/ln", ["-s", outside, join(base, "top-link")]);
      await rm(join(base, "top-link"), { recursive: true, force: true });
      result.push(existsSync(join(base, "top-link")), existsSync(join(outside, "keep/file.txt")));
      await rm(outside, { recursive: true, force: true });
      return result;
    });
    await check("fs.errors", async () => {
      const out: unknown[] = [];
      for (const run of [
        () => readFile(join(base, "missing.txt")),
        () => writeFile(join(base, "a.txt"), "x", { flag: "wx" }),
        () => rm(join(base, "missing"), {}),
        () => readdir(join(base, "a.txt")),
        () => mkdir(join(base, "x", "y")),
        () => readFile(base),
        () => access(join(base, "missing")),
        () => Promise.resolve().then(() => statSync(join(base, "nope")))
      ]) { try { await run(); out.push("ok"); } catch (error) { out.push(errorShape(error)); } }
      try { readFileSync(join(base, "missing")); } catch (error) { out.push(errorShape(error), (error as Error).message.replace(base, "<base>")); }
      return out;
    });
    await check("fs.mkdir-readdir", async () => {
      const made = await mkdir(join(base, "d1", "d2", "d3"), { recursive: true });
      const again = await mkdir(join(base, "d1", "d2"), { recursive: true });
      mkdirSync(join(base, "d1", "s"), { recursive: true });
      await writeFile(join(base, "d1", "f.txt"), "");
      const names = (await readdir(join(base, "d1"))).sort();
      const typed = (await readdir(join(base, "d1"), { withFileTypes: true })).map((e) => [e.name, e.isFile(), e.isDirectory()]).sort();
      return [made ? rel(made) : made, again ?? null, names, typed, readdirSync(join(base, "d1")).sort()];
    });
    await check("fs.rename-copy-rm", async () => {
      await rename(join(base, "c.txt"), join(base, "c2.txt"));
      await copyFile(join(base, "c2.txt"), join(base, "c3.txt"));
      let excl: unknown = "ok";
      try { await copyFile(join(base, "c2.txt"), join(base, "c3.txt"), constants.COPYFILE_EXCL); } catch (error) { excl = errorShape(error).code; }
      await rm(join(base, "d1"), { recursive: true, force: true });
      await rm(join(base, "never"), { force: true });
      rmSync(join(base, "c3.txt"));
      let dir: unknown = "ok";
      try { await rm(base); } catch (error) { dir = errorShape(error).code; }
      return [existsSync(join(base, "c.txt")), readFileSync(join(base, "c2.txt"), "utf8"), excl, existsSync(join(base, "d1")), dir];
    });
    await check("fs.filehandle", async () => {
      const path = join(base, "h.bin");
      const handle = await open(path, "w+", 0o600);
      const w1 = await handle.write(Buffer.from("0123456789"), 0, 10, 0);
      const w2 = await handle.write(Buffer.from("AB"), 0, 2, 4);
      const target = Buffer.alloc(6);
      const r = await handle.read(target, 1, 4, 3);
      await handle.sync();
      const size = (await handle.stat()).size;
      await handle.truncate(8);
      await handle.close();
      const appendHandle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      await appendHandle.writeFile("zz");
      await appendHandle.close();
      const readHandle = await open(path, "r");
      const whole = await readHandle.readFile("utf8");
      await readHandle.close();
      const mode = (await stat(path)).mode & 0o777;
      let closed: unknown = "ok";
      try { await readHandle.stat(); } catch (error) { closed = (error as { code?: string }).code; }
      const fd = openSync(join(base, "fd.txt"), "w"); closeSync(fd);
      return [w1.bytesWritten, w2.bytesWritten, r.bytesRead, target.toString("latin1").replace(/\0/g, "."), size, whole, mode, closed, typeof fd];
    });
    await check("fs.readstream", async () => {
      const path = join(base, "big.bin");
      const bytes = Buffer.alloc(300_000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
      await writeFile(path, bytes);
      const hash = createHash("sha256");
      let chunks = 0;
      for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) { hash.update(chunk as Buffer); chunks++; }
      const viaEvents = await new Promise<number>((resolve, reject) => {
        let total = 0;
        createReadStream(path, { start: 10, end: 109 }).on("data", (c) => { total += (c as Buffer).length; }).on("end", () => resolve(total)).on("error", reject);
      });
      const controller = new AbortController();
      let aborted: unknown = "none";
      try {
        for await (const _ of createReadStream(path, { highWaterMark: 1024, signal: controller.signal })) controller.abort();
      } catch (error) { aborted = (error as Error).name; }
      let missing: unknown = "none";
      try { for await (const _ of createReadStream(join(base, "missing"))) { /* none */ } } catch (error) { missing = errorShape(error).code; }
      return [hash.digest("hex"), chunks, viaEvents, aborted, missing];
    });
  } finally {
    await rm(base, { recursive: true, force: true });
    report("fs.cleanup", existsSync(base));
  }

  // Child processes
  await check("spawn.cat", async () => {
    const child = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
    child.stdin.write(JSON.stringify({ text: "שלום" }) + "\n");
    child.stdin.end("bye\n");
    const [code, signal] = await once(child, "close");
    return [typeof child.pid, code, signal, chunks.join(""), child.exitCode];
  });
  await check("spawn.exit-code", async () => {
    const child = spawn("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"]);
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
    const events: unknown[] = [];
    child.on("exit", (code, signal) => events.push(["exit", code, signal]));
    const [code] = await once(child, "close");
    return [code, out, err, events];
  });
  await check("spawn.kill", async () => {
    const child = spawn("/bin/sleep", ["5"], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child, "spawn");
    const sent = child.kill("SIGTERM");
    const [code, signal] = await once(child, "close");
    return [sent, code, signal, child.killed, child.signalCode, child.kill()];
  });
  await check("spawn.enoent", async () => {
    const child = spawn("/nonexistent/meluli-helper", []);
    const [error] = await once(child, "error").catch((e) => [e]);
    return [errorShape(error).code, child.pid ?? null];
  });
  await check("spawn.eacces", async () => {
    // A file that is there but not executable fails with EACCES, not ENOENT.
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "meluli-eacces-"));
    const path = join(dir, "not-executable");
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o644 });
    try {
      const child = spawn(path, []);
      const [error] = await once(child, "error").catch((e) => [e]);
      const { code, errno, syscall } = errorShape(error);
      return [code, errno, String(syscall).replace(dir, "<dir>"), (error as Error).message.replace(dir, "<dir>"), child.pid ?? null];
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  await check("spawn.path-lookup", async () => {
    const child = spawn("echo", ["looked", "up"]);
    let out = ""; child.stdout.on("data", (c) => (out += c));
    await once(child, "close");
    return out;
  });
  await check("spawn.ignore-stdio", async () => {
    const child = spawn("/bin/sh", ["-c", "cat >/dev/null; echo done"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; child.stdout.on("data", (c) => (out += c));
    child.stdin.end("data");
    const [code] = await once(child, "close");
    return [code, out, child.stderr === null];
  });
  await check("spawn.env-cwd", async () => {
    const child = spawn("/bin/sh", ["-c", 'printf "%s|%s" "$MELULI_X" "$(pwd -P)"'], { env: { PATH: "/usr/bin:/bin", MELULI_X: "ש" }, cwd: "/usr" });
    let out = ""; child.stdout.on("data", (c) => (out += c));
    await once(child, "close");
    return out;
  });
  await check("spawn.epipe", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdinError = false;
    child.stdin.on("error", () => { stdinError = true; });
    await once(child, "close");
    child.stdin.write("late\n");
    await new Promise((r) => setTimeout(r, 50));
    return [child.exitCode, typeof stdinError];
  });
  await check("execFile.ok", () => new Promise((resolve) => {
    execFile("/bin/echo", ["a", "ב"], (error, stdout, stderr) => resolve([error, stdout, stderr]));
  }));
  await check("execFile.fail", () => new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "echo partial; exit 2"], { timeout: 4000 }, (error, stdout) => resolve([(error as { code?: unknown })?.code, (error as { killed?: unknown })?.killed, stdout, error instanceof Error]));
  }));
  await check("execFile.timeout", () => new Promise((resolve) => {
    execFile("/bin/sleep", ["5"], { timeout: 100 }, (error) => resolve([(error as { killed?: unknown })?.killed, (error as { signal?: unknown })?.signal, (error as { code?: unknown })?.code]));
  }));
  await check("execFile.maxBuffer", () => new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "yes | head -c 100000"], { maxBuffer: 1000 }, (error, stdout) => resolve([(error as { code?: unknown })?.code, typeof stdout]));
  }));
  await check("execFile.stdin", () => new Promise((resolve) => {
    const child = execFile("/bin/cat", [], { timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve([error, stdout]));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify({ pid: 1, text: "טקסט" }) + "\n");
  }));
  await check("execFile.promisify", async () => {
    const run = promisify(execFile);
    const { stdout } = await run("/bin/echo", ["promised"]);
    let failed: unknown = null;
    try { await run("/bin/sh", ["-c", "exit 4"]); } catch (error) { failed = [(error as { code?: unknown }).code, typeof (error as { stdout?: unknown }).stdout]; }
    return [stdout, failed];
  });
  await check("execFile.enoent", () => new Promise((resolve) => {
    execFile("/nonexistent/x", [], (error) => resolve([(error as { code?: unknown })?.code]));
  }));

  // Worker (inline in the host)
  await check("worker.eval", async () => {
    const worker = new Worker(`const { parentPort } = require("node:worker_threads");
      parentPort.on("message", ({ n }) => { const b = Buffer.alloc(4); b.writeUInt32LE(n * 2, 0); parentPort.postMessage({ hex: b.toString("hex") }); });`, { eval: true });
    const reply = new Promise((resolve) => worker.once("message", resolve));
    worker.postMessage({ n: 21 });
    const message = await reply;
    await worker.terminate();
    return message;
  });

  // fetch against the harness's local server
  if (port) {
    const origin = `http://127.0.0.1:${port}`;
    await check("fetch.json", async () => {
      const response = await fetch(`${origin}/json`, { headers: { "X-Test": "1" } });
      return [response.status, response.ok, response.headers.get("content-type"), response.headers.get("X-Echo"), await response.json(), response.bodyUsed];
    });
    await check("fetch.post", async () => {
      const response = await fetch(`${origin}/echo`, { method: "POST", body: JSON.stringify({ text: "שלום" }), headers: { "content-type": "application/json" } });
      const copy = response.clone();
      return [await response.text(), await copy.text(), response.headers.get("x-method")];
    });
    await check("fetch.binary", async () => {
      const response = await fetch(`${origin}/echo`, { method: "PUT", body: new Uint8Array([0, 1, 2, 255]) });
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    await check("fetch.stream", async () => {
      const response = await fetch(`${origin}/stream`);
      const parts: number[] = [];
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) parts.push(chunk.byteLength);
      return [parts.reduce((a, b) => a + b, 0), parts.length > 1];
    });
    await check("fetch.redirect", async () => {
      const manual = await fetch(`${origin}/redirect`, { redirect: "manual" });
      const follow = await fetch(`${origin}/redirect`);
      return [manual.status, manual.headers.get("location"), follow.status, new URL(follow.url).pathname, await follow.json()];
    });
    // The Anthropic SDK tests `body instanceof FormData` before every request.
    await check("globals.FormData", async () => [typeof FormData, ({}) instanceof FormData]);
    await check("fetch.redirect-error", async () => {
      try { await fetch(`${origin}/redirect`, { redirect: "error" }); return "resolved"; }
      catch (error) { return [(error as Error).name, (error as Error).message, ((error as Error).cause as Error | undefined)?.message ?? null]; }
    });
    await check("fetch.404", async () => { const r = await fetch(`${origin}/missing`); return [r.status, r.ok, await r.text()]; });
    await check("fetch.abort-before", async () => {
      const controller = new AbortController();
      const pending = fetch(`${origin}/slow`, { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      try { await pending; return "resolved"; } catch (error) { return (error as Error).name; }
    });
    await check("fetch.abort-body", async () => {
      const controller = new AbortController();
      const response = await fetch(`${origin}/drip`, { signal: controller.signal });
      const reader = (response.body as unknown as { getReader(): { read(): Promise<{ done: boolean }> } }).getReader();
      await reader.read();
      controller.abort();
      try { while (!(await reader.read()).done) { /* drain */ } return "ended"; } catch (error) { return (error as Error).name; }
    });
    await check("fetch.timeout-signal", async () => {
      try { await fetch(`${origin}/slow`, { signal: AbortSignal.timeout(50) }); return "resolved"; } catch (error) { return (error as Error).name; }
    });
    await check("fetch.refused", async () => {
      try { await fetch("http://127.0.0.1:9/"); return "resolved"; } catch (error) { return [(error as Error).name, (error as Error).message]; }
    });
    await check("fetch.headers", () => {
      const headers = new Headers({ "Content-Type": "a" });
      headers.append("x-a", "1"); headers.append("X-A", "2");
      const pairs: [string, string][] = []; headers.forEach((value, key) => pairs.push([key, value]));
      return [pairs.sort(), headers.has("content-type"), headers.get("missing")];
    });
    await check("fetch.response-ctor", async () => { const r = new Response("hi", { status: 201, headers: { a: "b" } }); return [r.status, r.ok, r.headers.get("a"), await r.text()]; });
  }

  // better-sqlite3 runs only in the host here (Node's build of it targets Electron); the harness
  // checks these against fixed expectations.
  if (process.versions.meluliNative) await sqliteChecks();

  report("done", results.length);
  process.exit(0);
}

async function sqliteChecks() {
  const { createRequire } = await import("node:module");
  const Database = createRequire(import.meta.url)("better-sqlite3") as typeof import("better-sqlite3");
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "meluli-sqlite-"));
  try {
    await check("sqlite.basic", () => {
      const db = new Database(join(dir, "t.db"));
      db.pragma("journal_mode = WAL");
      const mode = db.pragma("journal_mode", { simple: true });
      db.pragma("user_version = 7");
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, score REAL, data BLOB, flag INTEGER)");
      const insert = db.prepare("INSERT INTO t (name, score, data, flag) VALUES (?, ?, ?, ?)");
      const r1 = insert.run("שלום", 1.5, Buffer.from([1, 2]), true);
      const r2 = insert.run("b", null, null, false);
      const named = db.prepare("SELECT name FROM t WHERE id = @id OR name = :name").all({ id: 1, name: "b" });
      const row = db.prepare("SELECT * FROM t WHERE id = ?").get(1) as Record<string, unknown>;
      const none = db.prepare("SELECT * FROM t WHERE id = ?").get(99);
      const count = db.prepare("SELECT count(*) FROM t").pluck().get();
      let unique: unknown = null;
      try { insert.run("b", 0, null, 0); } catch (error) { unique = (error as { code?: string }).code; }
      let notReader: unknown = null;
      try { db.prepare("DELETE FROM t WHERE id = 99").get(); } catch (error) { notReader = (error as Error).message; }
      let multi: unknown = null;
      try { db.prepare("SELECT 1; SELECT 2"); } catch (error) { multi = (error as Error).message; }
      const version = db.pragma("user_version", { simple: true });
      const list = db.pragma("table_info(t)") as { name: string }[];
      db.close();
      let closed: unknown = null;
      try { db.prepare("SELECT 1"); } catch (error) { closed = (error as Error).message; }
      return [mode, r1, r2, named, row.name, row.score, Array.from(row.data as Uint8Array), row.flag, none, count, unique, notReader, multi, version, list.map((c) => c.name), closed];
    });
    await check("sqlite.transaction", () => {
      const db = new Database(join(dir, "t2.db"));
      db.exec("CREATE TABLE k (v INTEGER)");
      const add = db.prepare("INSERT INTO k VALUES (?)");
      const many = db.transaction((values: number[]) => { for (const v of values) add.run(v); return values.length; });
      const inserted = many([1, 2, 3]);
      const failing = db.transaction(() => { add.run(4); throw new Error("stop"); });
      let failed = "";
      try { failing(); } catch (error) { failed = (error as Error).message; }
      const outer = db.transaction(() => {
        add.run(5);
        try { db.transaction(() => { add.run(6); throw new Error("inner"); })(); } catch { /* inner rolled back */ }
        add.run(7);
      });
      outer();
      const values = db.prepare("SELECT v FROM k ORDER BY v").pluck().all();
      const inTx = db.inTransaction;
      db.prepare("VACUUM INTO ?").run(join(dir, "copy.db"));
      const copy = new Database(join(dir, "copy.db"), { readonly: true });
      const copied = copy.prepare("SELECT count(*) AS n FROM k").get();
      copy.close(); db.close();
      return [inserted, failed, values, inTx, copied];
    });
    await check("sqlite.fts", () => {
      const db = new Database(":memory:");
      db.pragma("trusted_schema = OFF");
      db.exec("CREATE VIRTUAL TABLE f USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
      db.prepare("INSERT INTO f (text) VALUES (?)").run("שלום עולם hello");
      const hits = db.prepare("SELECT text FROM f WHERE f MATCH ?").all("עולם");
      db.close();
      return hits;
    });
    await check("sqlite.bigint", () => {
      const db = new Database(":memory:");
      const big = db.prepare("SELECT ? AS a, ? AS b").get(2 ** 40, 10n) as Record<string, unknown>;
      db.close();
      return [big.a, big.b];
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error("conformance crashed", error); process.exit(1); });
