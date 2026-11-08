// The JS side of UIBridge (native/host/Electron/UIBridge.swift). One rule carries over from there:
// JS may wait on the main thread (`ui`), the main thread never waits on JS (it only emits events).
import { createIpcCodec } from "../ipc-codec";

type HostHandler = (payload: any) => void;
const handlers = new Map<string, Set<HostHandler>>();

__native.uiEvents((event: string, payload: unknown) => {
  const set = handlers.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (error) {
      reportUncaught(error);
    }
  }
});

export function reportUncaught(error: unknown): void {
  const text = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  __native.log("error", `[electron] ${text}`);
}

/** Runs a main-thread operation and returns its result. Throws what the operation threw. */
export function ui<T = unknown>(op: string, ...args: unknown[]): T {
  return __native.ui(op, args) as T;
}

/** Queues a main-thread operation without waiting for it. Its order with `ui` calls is kept. */
export function post(op: string, ...args: unknown[]): void {
  __native.uiPost(op, args);
}

/** An operation that answers later: a dialog, a menu, a permission prompt. */
export function call<T = unknown>(op: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve) => __native.uiAsync(op, args, (result: T) => resolve(result)));
}

export function onHost(event: string, handler: HostHandler): () => void {
  const set = handlers.get(event) ?? new Set();
  handlers.set(event, set);
  set.add(handler);
  return () => set.delete(handler);
}

const codec = createIpcCodec({ encode: (bytes) => __native.base64Encode(bytes), decode: (text) => __native.base64Decode(text) });

/** Main → renderer. */
export const encodePayload = (value: unknown): string => codec.encode(value);

/** Renderer → main. */
export const decodePayload = (text: string): unknown => codec.decode(text);
