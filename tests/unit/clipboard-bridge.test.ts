/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { ClipboardBridgeService, ClipboardUnavailableError } from "../../src/main/services/insertion/clipboard-bridge.service";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function helper() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}
describe("clipboard helper lifecycle", () => {
  it("starts the helper with only the minimal environment", () => {
    process.env.DYLD_INSERT_LIBRARIES = "/tmp/not-loaded.dylib";
    try {
      helper();
      void new ClipboardBridgeService("fixture").begin("text").catch(() => undefined);
      const env = vi.mocked(spawn).mock.calls.at(-1)![2]!.env!;
      expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin:/bin");
    } finally { delete process.env.DYLD_INSERT_LIBRARIES; }
  });
  it('quarantines an uncertain paste until watchdog cleanup without closing stdin immediately',async()=>{
    const child=helper();const promise=new ClipboardBridgeService('fixture').begin('transcript');child.stdout.write('{"ready":true}\n');const lease=await promise;
    const pending=lease.quarantine!();expect(child.stdin.writableEnded).toBe(false);expect(lease.restore()).toBe(pending);
    child.emit('close',0);await pending;expect(child.kill).not.toHaveBeenCalled();
  });
  it('bounds quarantine when an unresponsive clipboard helper never reaches its watchdog',async()=>{
    vi.useFakeTimers();const child=helper();const promise=new ClipboardBridgeService('fixture').begin('text');child.stdout.write('{"ready":true}\n');const lease=await promise;
    const pending=lease.quarantine!();await vi.advanceTimersByTimeAsync(11000);await pending;expect(child.kill.mock.calls).toEqual([['SIGTERM'],['SIGKILL']]);
  });
  it("restores once, shares the pending promise and completes when the helper exits", async () => {
    const child = helper();
    const promise = new ClipboardBridgeService("fixture").begin("private text");
    child.stdout.write('{"ready":true}\n');
    const lease = await promise;
    const first = lease.restore();
    expect(lease.restore()).toBe(first);
    child.emit("close", 0);
    await first;
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("bounds restoration even when a helper ignores EOF and SIGTERM", async () => {
    vi.useFakeTimers(); const child = helper();
    const promise = new ClipboardBridgeService("fixture").begin("text"); child.stdout.write('{"ready":true}\n');
    const lease = await promise; const restored = lease.restore();
    await vi.advanceTimersByTimeAsync(11_000);
    await restored;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
  it("waits for cleanup after readiness timeout and ignores late readiness", async () => {
    vi.useFakeTimers(); const child = helper();
    let settled = false;
    const promise = new ClipboardBridgeService("fixture").begin("text");
    const observed = promise.then(() => { settled = true; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.stdin.writableEnded).toBe(true);
    expect(settled).toBe(false);
    child.stdout.write('{"ready":true}\n');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 0);
    expect(await observed).toEqual(new ClipboardUnavailableError("Clipboard helper did not become ready."));
  });
  it("bounds startup-failure cleanup when the helper never exits", async () => {
    vi.useFakeTimers(); const child = helper();
    const promise = new ClipboardBridgeService("fixture").begin("text");
    const rejected = expect(promise).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(14_000);
    await rejected;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
  it("waits for helper cleanup after a broken input pipe", async () => {
    const child = helper(); let settled = false;
    const promise = new ClipboardBridgeService("fixture").begin("text");
    const observed = promise.catch(error => { settled = true; return error; });
    child.stdin.emit("error", new Error("EPIPE"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.stdin.writableEnded).toBe(true);
    child.emit("close", 1);
    expect(await observed).toEqual(new ClipboardUnavailableError("Clipboard helper unavailable."));
  });
  it("rejects a spawn failure without waiting for a readiness deadline", async () => {
    const child = helper();
    const promise = new ClipboardBridgeService("fixture").begin("text");
    const rejected = expect(promise).rejects.toThrow("unavailable");
    child.emit("error", new Error("ENOENT"));
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();
  });
});
