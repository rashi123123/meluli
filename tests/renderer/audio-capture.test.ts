import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioCaptureController } from "@/lib/audio-capture";

let stopped: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let addModule: ReturnType<typeof vi.fn>;
let context: MockContext;
let worklet: MockWorklet;
let stream: MediaStream;
const disconnect = vi.fn();
class MockContext {
  sampleRate = 16000;
  state = "running";
  destination = {};
  audioWorklet = { addModule: (...args: unknown[]) => addModule(...args) };
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect }));
  constructor() { context = this; }
}
class MockWorklet {
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    close: vi.fn(),
    postMessage: vi.fn(() => {
      this.port.onmessage?.(new MessageEvent("message", { data: new Float32Array([0.3]) }));
      this.port.onmessage?.(new MessageEvent("message", { data: { type: "flushed" } }));
    })
  };
  connect = vi.fn(); disconnect = vi.fn();
  constructor() { worklet = this; }
}
beforeEach(() => {
  stopped = vi.fn();
  stream = { getTracks: () => [{ stop: stopped, addEventListener: vi.fn() }] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  addModule = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", MockContext);
  vi.stubGlobal("AudioWorkletNode", MockWorklet);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("microphone lifecycle (simulated devices)", () => {
  it("resumes a context suspended during shortcut startup before capture is ready", async () => {
    addModule.mockImplementation(async () => { context.state = "suspended"; });
    const controller = new AudioCaptureController();
    await controller.start();
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.state).toBe("running");
    await controller.destroy();
  });
  it("stops the microphone and closes AudioContext if worklet startup fails", async () => {
    addModule.mockRejectedValue(new Error("worklet unavailable"));
    const controller = new AudioCaptureController();
    await expect(controller.start()).rejects.toThrow("worklet unavailable");
    expect(stopped).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(controller.getMediaStream()).toBeNull();
  });
  it("includes the worklet's final buffer before returning audio and releases resources", async () => {
    const controller = new AudioCaptureController();
    await controller.start();
    worklet.port.onmessage?.(new MessageEvent("message", { data: new Float32Array([0.1, 0.2]) }));
    const payload = await controller.stop();
    expect(Array.from(payload.pcm as Float32Array)).toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3])));
    expect(payload.durationMs).toBe(3 / 16000 * 1000);
    expect(stopped).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(worklet.port.close).toHaveBeenCalledTimes(1);
  });
  it("opens the input before building the graph, which would slow it down", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    getUserMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolveStream = resolve; }));
    const controller = new AudioCaptureController();
    const starting = controller.start();
    await Promise.resolve();
    expect(addModule).not.toHaveBeenCalled();
    resolveStream(stream);
    await starting;
    expect(addModule).toHaveBeenCalledOnce();
  });
  it("does not leak a stream whose permission request resolves after unmount", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    getUserMedia.mockImplementation(() => new Promise<MediaStream>(resolve => { resolveStream = resolve; }));
    const controller = new AudioCaptureController();
    const starting = controller.start();
    const rejected = expect(starting).rejects.toThrow();
    await controller.destroy();
    resolveStream(stream);
    await rejected;
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(controller.getMediaStream()).toBeNull();
  });
  it("deduplicates concurrent microphone start requests", async () => {
    const controller = new AudioCaptureController();
    await Promise.all([controller.start(), controller.start()]);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await controller.destroy();
  });
});
