// child_process over the host's Process wrapper. `spawn` and `execFile` behave as Node's for the
// app's helpers: line protocols on stdin and stdout, `exit` then `close`, errors as events.
import { EventEmitter } from "./events";
import { Buffer } from "./buffer";
import { Readable, Writable } from "./stream";
import { abortError, SIGNAL_NAMES, SIGNAL_NUMBERS } from "./signals";

type Stdio = "pipe" | "ignore" | "inherit" | null | undefined;
interface SpawnOptions { cwd?: string; env?: Record<string, string | undefined>; stdio?: Stdio | Stdio[]; timeout?: number; signal?: AbortSignal; killSignal?: string | number; detached?: boolean; windowsHide?: boolean }

function resolveCommand(command: string, env: Record<string, string | undefined>): string {
  if (command.includes("/")) return command;
  for (const dir of (env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":")) {
    const candidate = `${dir || "."}/${command}`;
    try { if (__native.fsSync("access", [candidate, 1], null) === undefined) return candidate; } catch { /* next */ }
  }
  return command;
}

export class ChildProcess extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  spawnfile: string;
  spawnargs: string[];
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  readonly stdio: [Writable | null, Readable | null, Readable | null];
  private id = 0;
  private done = false;

  constructor(command: string, args: string[], options: SpawnOptions) {
    super();
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    const stdio = Array.isArray(options.stdio) ? options.stdio : [options.stdio, options.stdio, options.stdio];
    const kind = (index: number) => (stdio[index] === "ignore" ? "ignore" : "pipe");
    if (kind(0) === "pipe") {
      this.stdin = new Writable({
        write: (bytes) => (this.id ? __native.processWrite(this.id, bytes) : false),
        end: () => { if (this.id) __native.processEndInput(this.id); }
      });
    }
    if (kind(1) === "pipe") this.stdout = new Readable();
    if (kind(2) === "pipe") this.stderr = new Readable();
    this.stdio = [this.stdin, this.stdout, this.stderr];

    const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
    const path = resolveCommand(command, env);
    try {
      const started = __native.spawn(path, args.map(String), { cwd: options.cwd, env, stdin: kind(0), stdout: kind(1), stderr: kind(2) }, (event, ...rest) => this.onEvent(event, rest));
      this.id = started.id;
      this.pid = started.pid;
      queueMicrotask(() => this.emit("spawn"));
    } catch (error) {
      // The host's code and errno (EACCES for a file that is not executable), as Node reports them.
      const { code = "ENOENT", errno = -2 } = error as { code?: string; errno?: number };
      const failure = Object.assign(new Error(`spawn ${command} ${code}`), { errno, code, syscall: `spawn ${command}`, path: command, spawnargs: args });
      this.done = true;
      queueMicrotask(() => {
        this.emit("error", failure);
        this.stdout?.push(null); this.stderr?.push(null); this.stdin?.destroy();
        this.emit("close", -2, null);
      });
    }
    if (options.signal) {
      const signal = options.signal;
      const abort = () => { this.kill(options.killSignal ?? "SIGTERM"); this.emit("error", abortError(signal)); };
      if (signal.aborted) queueMicrotask(abort); else signal.addEventListener("abort", abort, { once: true });
    }
  }

  private onEvent(event: string, args: any[]) {
    switch (event) {
      case "stdout": this.stdout?.push(args[0] as Uint8Array); break;
      case "stderr": this.stderr?.push(args[0] as Uint8Array); break;
      case "end": (args[0] === "stdout" ? this.stdout : this.stderr)?.push(null); break;
      case "stdinError": this.stdin?.emit("error", Object.assign(new Error(`write EPIPE`), { code: "EPIPE", syscall: "write" })); break;
      case "exit": {
        const [code, signal] = args as [number | null, number | null];
        this.exitCode = code;
        this.signalCode = signal === null ? null : SIGNAL_NAMES[signal] ?? `SIG${signal}`;
        this.emit("exit", this.exitCode, this.signalCode);
        break;
      }
      case "close": {
        this.done = true;
        if (this.stdin && !this.stdin.destroyed) { this.stdin.writable = false; this.stdin.destroyed = true; }
        this.emit("close", this.exitCode, this.signalCode);
        break;
      }
    }
  }

  kill(signal: string | number = "SIGTERM"): boolean {
    if (this.done || !this.id) return false;
    const number = typeof signal === "number" ? signal : SIGNAL_NUMBERS[signal];
    if (number === undefined) throw Object.assign(new TypeError(`Unknown signal: ${String(signal)}`), { code: "ERR_UNKNOWN_SIGNAL" });
    const sent = __native.processKill(this.id, number);
    if (sent) this.killed = true;
    return sent;
  }
  ref() { return this; }
  unref() { return this; }
  disconnect() {}
}

/** Kills the child with its kill signal once `timeout` passes, unless it exits first. */
function killOnTimeout(child: ChildProcess, options: SpawnOptions, onKill?: () => void): ReturnType<typeof setTimeout> | null {
  if (!options.timeout || options.timeout <= 0) return null;
  const timer = setTimeout(() => { onKill?.(); child.kill(options.killSignal ?? "SIGTERM"); }, options.timeout);
  child.once("exit", () => clearTimeout(timer));
  return timer;
}

export function spawn(command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
  if (!Array.isArray(args)) { options = args as SpawnOptions | undefined; args = []; }
  const child = new ChildProcess(command, [...(args as string[])], options ?? {});
  killOnTimeout(child, options ?? {});
  return child;
}

type ExecError = Error & { code?: unknown; killed?: boolean; signal?: string | null; cmd?: string; stdout?: unknown; stderr?: unknown };
interface ExecFileOptions extends SpawnOptions { encoding?: string | null; maxBuffer?: number }
type ExecCallback = (error: (Error & { code?: number | string | null; killed?: boolean; signal?: string | null; cmd?: string; stdout?: unknown; stderr?: unknown }) | null, stdout: string | Buffer, stderr: string | Buffer) => void;

export function execFile(file: string, args?: readonly string[] | ExecFileOptions | ExecCallback | null, options?: ExecFileOptions | ExecCallback | null, callback?: ExecCallback): ChildProcess {
  if (typeof args === "function") { callback = args; args = []; options = {}; }
  else if (args && !Array.isArray(args)) { callback = options as ExecCallback | undefined; options = args as ExecFileOptions; args = []; }
  if (typeof options === "function") { callback = options; options = {}; }
  const list = [...((args as string[] | null) ?? [])];
  const settings = (options as ExecFileOptions | null) ?? {};
  const maxBuffer = settings.maxBuffer ?? 1024 * 1024;
  const encoding = settings.encoding === undefined ? "utf8" : settings.encoding;
  const child = new ChildProcess(file, list, { ...settings, stdio: "pipe" });
  const out: Uint8Array[] = [], err: Uint8Array[] = [];
  let outBytes = 0, errBytes = 0;
  let failure: ExecError | null = null;
  let timedOut = false;
  let finished = false;
  const text = (parts: Uint8Array[]) => { const bytes = Buffer.concat(parts); return encoding && encoding !== "buffer" ? bytes.toString(encoding) : bytes; };
  const finish = (code: number | null, signal: string | null) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    const stdout = text(out), stderr = text(err);
    if (!failure && (code !== 0 || signal)) {
      const command = [file, ...list].join(" ");
      failure = Object.assign(new Error(`Command failed: ${command}\n${typeof stderr === "string" ? stderr : ""}`), { code, killed: child.killed || timedOut, signal, cmd: command });
    }
    if (failure) { failure.stdout = stdout; failure.stderr = stderr; }
    callback?.(failure as Parameters<ExecCallback>[0], stdout, stderr);
  };
  const overflow = (stream: string) => {
    if (failure) return;
    failure = Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    child.kill(settings.killSignal ?? "SIGTERM");
  };
  child.stdout!.on("data", (chunk: Uint8Array) => { outBytes += chunk.byteLength; if (outBytes > maxBuffer) overflow("stdout"); else out.push(chunk); });
  child.stderr!.on("data", (chunk: Uint8Array) => { errBytes += chunk.byteLength; if (errBytes > maxBuffer) overflow("stderr"); else err.push(chunk); });
  child.on("error", (error: ExecError) => { failure = failure ?? error; if (child.pid === undefined) finish(null, null); });
  child.on("close", (code: number | null, signal: string | null) => finish(code, signal));
  const timer = killOnTimeout(child, settings, () => { timedOut = true; });
  return child;
}

const custom = Symbol.for("nodejs.util.promisify.custom");
(execFile as unknown as Record<symbol, unknown>)[custom] = (file: string, args?: readonly string[], options?: ExecFileOptions) =>
  new Promise((resolve, reject) => {
    execFile(file, args ?? [], options ?? {}, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });

export function exec(): never { throw new Error("child_process.exec (a shell) is not available in the native host"); }
export function execSync(): never { throw new Error("child_process.execSync is not available in the native host"); }
export function spawnSync(): never { throw new Error("child_process.spawnSync is not available in the native host"); }
export function execFileSync(): never { throw new Error("child_process.execFileSync is not available in the native host"); }
export function fork(): never { throw new Error("child_process.fork is not available in the native host"); }
export default { spawn, execFile, exec, execSync, spawnSync, execFileSync, fork, ChildProcess };
