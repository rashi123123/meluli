/* @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { IvritMenuBarApi } from "@shared/preload-api";

const electron = vi.hoisted(() => ({
  exposed: null as unknown,
  listeners: new Map<string, (event: unknown, payload?: unknown) => void>()
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { electron.exposed = api; } },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload?: unknown) => void) => electron.listeners.set(channel, listener),
    off: (channel: string) => electron.listeners.delete(channel),
    invoke: vi.fn(), send: vi.fn()
  },
  webUtils: { getPathForFile: () => "" }
}));

/** Loads the preload as the page with this query would, and returns what it exposed. */
async function preloadFor(search: string): Promise<IvritMenuBarApi> {
  vi.resetModules();
  electron.listeners.clear();
  vi.stubGlobal("location", { search });
  await import("../../src/preload/index");
  return electron.exposed as IvritMenuBarApi;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("preload roles", () => {
  it.each([["main", ""], ["overlay", "?window=overlay"]])("lets the %s window hear a sleep or lock interrupt", async (_role, search) => {
    const api = await preloadFor(search);
    const listener = vi.fn();
    const unsubscribe = api.app.onRecordingInterruptRequested(listener);
    electron.listeners.get(IPC_CHANNELS.recordingInterruptRequested)?.({});
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(electron.listeners.has(IPC_CHANNELS.recordingInterruptRequested)).toBe(false);
  });
});
