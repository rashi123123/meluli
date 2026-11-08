// The "electron" module for the renderer preload in the native app (D20). The preload bundle runs
// as a WKUserScript at document start; this file gives src/preload/index.ts the three things it
// imports, the page's base64 for the shared IPC codec (../ipc-codec.ts), and the window drag regions.
import { createIpcCodec } from "../ipc-codec";

// Names the Swift host shares with this page (native/host/HostNames.swift: pageMessageHandler, pageReceive,
// pageDragged, PageMessage).
const PAGE_MESSAGE_HANDLER = "meluliIpc";
const PAGE_RECEIVE = "__meluliReceive";
const PAGE_DRAGGED = "__meluliDragged";
type PageMessageKind = "invoke" | "send" | "regions";

interface IpcHandler {
  postMessage(message: { kind: PageMessageKind; channel?: string; payload?: string; drag?: number[][]; noDrag?: number[][] }): Promise<unknown>;
}
type Listener = (event: { sender: typeof ipcRenderer }, ...args: unknown[]) => void;

/** The page's window with WebKit's script message handlers, where the host listens. */
const page: Window & { webkit?: { messageHandlers?: Record<string, IpcHandler | undefined> } } = window;
const host: IpcHandler | undefined = page.webkit?.messageHandlers?.[PAGE_MESSAGE_HANDLER];
const listeners = new Map<string, Set<Listener>>();

// ---------------------------------------------------------------------------------------------
// Codec

// Uint8Array.prototype.toBase64 and Uint8Array.fromBase64 are newer than the TypeScript lib in use.
const nativeToBase64 = (Uint8Array.prototype as { toBase64?: (this: Uint8Array) => string }).toBase64;
const nativeFromBase64 = (Uint8Array as { fromBase64?: (text: string) => Uint8Array }).fromBase64;

const toBase64: (bytes: Uint8Array) => string = typeof nativeToBase64 === "function"
  ? (bytes) => nativeToBase64.call(bytes)
  : (bytes) => {
    let text = "";
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
  };

const fromBase64: (text: string) => Uint8Array = typeof nativeFromBase64 === "function"
  ? (text) => nativeFromBase64.call(Uint8Array, text)
  : (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

const { encode, decode } = createIpcCodec({ encode: toBase64, decode: fromBase64 });

// ---------------------------------------------------------------------------------------------
// ipcRenderer

function unavailable(): Promise<never> {
  return Promise.reject(new Error("The native host is not available"));
}

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!host) return unavailable();
    let payload: string;
    try { payload = encode(args); } catch (error) { return Promise.reject(error); }
    return host.postMessage({ kind: "invoke", channel, payload }).then(decode);
  },
  send(channel: string, ...args: unknown[]): void {
    void host?.postMessage({ kind: "send", channel, payload: encode(args) }).catch(() => {});
  },
  on(channel: string, listener: Listener) {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return ipcRenderer;
  },
  once(channel: string, listener: Listener) {
    const wrapped: Listener = (event, ...args) => { ipcRenderer.off(channel, wrapped); listener(event, ...args); };
    return ipcRenderer.on(channel, wrapped);
  },
  off(channel: string, listener: Listener) {
    listeners.get(channel)?.delete(listener);
    return ipcRenderer;
  },
  removeListener(channel: string, listener: Listener) { return ipcRenderer.off(channel, listener); },
  removeAllListeners(channel?: string) {
    if (channel) listeners.delete(channel); else listeners.clear();
    return ipcRenderer;
  }
};

// Main → page: WindowController.send calls this with the channel and the JSON of the arguments.
Object.defineProperty(page, PAGE_RECEIVE, {
  value: (channel: string, payload: string) => {
    const set = listeners.get(channel);
    if (!set || set.size === 0) return;
    const decoded = decode(payload);
    const args = Array.isArray(decoded) ? decoded : [decoded];
    for (const listener of [...set]) {
      try { listener({ sender: ipcRenderer }, ...args); } catch (error) { console.error(error); }
    }
  },
  configurable: false,
  writable: false,
  enumerable: false
});

// ---------------------------------------------------------------------------------------------
// Microphone input (D21): WebKit meets echoCancellation and noiseSuppression with Apple's voice
// processing unit, which turns down every other app's sound while the input is open. On the dictation
// fixture played through a virtual input it got 10 of 14 words where the raw input got 13 (MEASURED
// 2026-11-06, same audio reaching the page in both). Chromium's processing does neither, and the
// native microphone turned voice processing off for the same reasons (D19), so pages here get the raw
// input whatever they ask for.

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as const;

if (typeof MediaDevices === "function" && typeof MediaDevices.prototype.getUserMedia === "function") {
  const getUserMedia = MediaDevices.prototype.getUserMedia;
  Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
    value(this: MediaDevices, constraints?: MediaStreamConstraints) {
      const audio = constraints?.audio;
      const raw = audio === true ? { ...RAW_AUDIO } : audio && typeof audio === "object" ? { ...audio, ...RAW_AUDIO } : audio;
      return getUserMedia.call(this, constraints ? { ...constraints, audio: raw } : constraints);
    },
    configurable: true,
    writable: true
  });
}

// ---------------------------------------------------------------------------------------------
// contextBridge and webUtils

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    Object.defineProperty(page, key, { value: Object.freeze(api), configurable: false, writable: false, enumerable: true });
  }
};

// The files in the drag over this page, from the host (HostWebView.shareDraggedFiles). A dropped File
// is matched by name and size, and by the nearest modification time when two share both.
interface DraggedFile { path: string; name: string; size: number; lastModified: number }
let dragged: DraggedFile[] = [];

Object.defineProperty(page, PAGE_DRAGGED, {
  value: (files: unknown) => {
    dragged = (Array.isArray(files) ? files : []).filter((entry): entry is DraggedFile =>
      Boolean(entry) && typeof entry.path === "string" && entry.path.startsWith("/") && typeof entry.name === "string"
      && typeof entry.size === "number" && typeof entry.lastModified === "number").slice(0, 64);
  },
  configurable: false,
  writable: false,
  enumerable: false
});

export const webUtils = {
  getPathForFile(file: File): string {
    const matches = dragged.filter((entry) => entry.name === file.name && entry.size === file.size);
    if (!matches.length) return "";
    const distance = (entry: DraggedFile) => Math.abs(entry.lastModified - file.lastModified);
    return matches.reduce((best, entry) => (distance(entry) < distance(best) ? entry : best)).path;
  }
};

// ---------------------------------------------------------------------------------------------
// Drag regions: WebKit ignores -webkit-app-region, so the page reports where .app-drag elements
// are and the window starts a native drag there (WindowController.handleDrag). Interactive
// elements inside them stay clickable, as the stylesheet's no-drag rule says.

const NO_DRAG = ".app-no-drag, button, input, select, textarea, a";
let lastRegions = "";
let pending = 0;

function rect(element: Element): number[] | null {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? [box.left, box.top, box.width, box.height].map((value) => Math.round(value * 10) / 10) : null;
}

function reportRegions(): void {
  pending = 0;
  if (!host) return;
  const drag: number[][] = [];
  const noDrag: number[][] = [];
  for (const element of document.querySelectorAll(".app-drag")) {
    const box = rect(element);
    if (!box) continue;
    drag.push(box);
    for (const child of element.querySelectorAll(NO_DRAG)) {
      const inner = rect(child);
      if (inner) noDrag.push(inner);
    }
  }
  const key = JSON.stringify([drag, noDrag]);
  if (key === lastRegions) return;
  lastRegions = key;
  void host.postMessage({ kind: "regions", drag, noDrag }).catch(() => {});
}

/** Coalesced: class and tree changes during an animation cost one measurement per 120 ms at most. */
function scheduleRegions(): void {
  if (pending) return;
  pending = window.setTimeout(reportRegions, 120);
}

if (host) {
  const start = () => {
    reportRegions();
    new MutationObserver(scheduleRegions).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", scheduleRegions, { passive: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
