import type { IvritMenuBarApi } from "@shared/preload-api";

// A stand-in for the preload bridge. Every call is recorded and answered locally;
// nothing reaches the main process, the disk, the microphone or the network.

export interface LabCall { id: number; path: string; args: string; at: number }

const listeners = new Set<(call: LabCall) => void>();
let sequence = 0;

export function onLabCall(listener: (call: LabCall) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function preview(args: unknown[]): string {
  try {
    return args.map(arg => typeof arg === "function" ? "ƒ" : JSON.stringify(arg)).join(", ").slice(0, 120);
  } catch {
    return "…";
  }
}

export function logLabCall(path: string, args: unknown[] = []): void {
  const call = { id: ++sequence, path, args: preview(args), at: Date.now() };
  for (const listener of listeners) listener(call);
}

type Answer = (...args: unknown[]) => unknown;
const answers = new Map<string, Answer>();

/** Sets what a bridge method resolves to, for stories that read from the bridge directly. */
export function answerBridge(path: string, answer: Answer): void {
  answers.set(path, answer);
}

answerBridge("app.version", () => "0.0.0-lab");
answerBridge("transcription.cancel", () => true);
answerBridge("clipboard.writeText", (text) => navigator.clipboard?.writeText(String(text ?? "")).catch(() => undefined));

// One object per path, like the real bridge: hooks that depend on a namespace must not see a new one each render.
const nodes = new Map<string, unknown>();

function node(path: string[]): unknown {
  const cacheKey = path.join(".");
  const cached = nodes.get(cacheKey);
  if (cached) return cached;
  const call = (...args: unknown[]) => {
    const key = path.join(".");
    const name = path.at(-1) ?? "";
    // Subscriptions hand back an unsubscribe function and never fire.
    if (/^on[A-Z]/.test(name)) return () => undefined;
    logLabCall(`bridge.${key}`, args);
    const answer = answers.get(key);
    return Promise.resolve(answer ? answer(...args) : undefined);
  };
  const proxy = new Proxy(call, {
    get: (_target, prop) => {
      // Not a thenable, so awaiting a namespace never hangs.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return node([...path, prop]);
    }
  });
  nodes.set(cacheKey, proxy);
  return proxy;
}

export function installMockBridge(): void {
  Object.defineProperty(window, "ivritMenuBar", { value: node([]) as IvritMenuBarApi, configurable: false, writable: false });
}
