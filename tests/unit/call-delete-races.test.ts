import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStateSnapshot, CallState, TranscriptSegment } from "../../src/shared/types";
import { CallService, type CallServiceDependencies } from "../../src/main/services/calls/call.service";
import { CallStore, createCallRecord, type CallRecord } from "../../src/main/services/calls/call-store";

class FakeRuntime extends EventEmitter {
  state = { status: "idle" } as AppStateSnapshot;
  getState() { return this.state; }
  updateState(next: Partial<AppStateSnapshot>) {
    this.state = { ...this.state, ...next };
    this.emit("state");
  }
}

function speechWav(): Buffer {
  const samples = new Int16Array(32_000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index >= 8_000 && index < 24_000 ? (index % 2 ? 8_000 : -8_000) : (index % 2 ? 40 : -40);
  }
  return Buffer.concat([Buffer.alloc(44), Buffer.from(samples.buffer)]);
}

function gate() {
  let open = () => undefined as void;
  const closed = new Promise<void>((resolve) => { open = resolve; });
  return { closed, open };
}

class FakeAudio {
  onApps: CallServiceDependencies["audio"]["onApps"] = null;
  onFault: CallServiceDependencies["audio"]["onFault"] = null;
  onGone: CallServiceDependencies["audio"]["onGone"] = null;
  watch = vi.fn();
  dispose = vi.fn();
  directory: string | null = null;
  stopGate: Promise<void> | null = null;
  stopEntered = false;
  async start(directory: string) {
    this.directory = directory;
    await writeFile(join(directory, "mic.wav"), speechWav());
    await writeFile(join(directory, "system.wav"), speechWav());
    return true;
  }
  async stop() {
    this.stopEntered = true;
    if (this.stopGate) await this.stopGate;
    return { micOffsetMs: 0, systemOffsetMs: 0, systemHeard: true };
  }
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

let root: string;
let clock: number;
let audio: FakeAudio;
let runtime: FakeRuntime;
let events: string[];
let stored: TranscriptSegment[][];
let transcribePiece: ReturnType<typeof vi.fn<CallServiceDependencies["transcribePiece"]>>;
let service: CallService;

const newRecord = createCallRecord as (id: string, appId: string, startedAt: number) => CallRecord;
const callState = () => runtime.getState().call as CallState;

function build(overrides: Partial<CallServiceDependencies> = {}) {
  return new CallService({
    audio: audio as never, runtime, root, isAvailable: () => true, isEnabled: () => true, requestMicrophone: async () => true,
    transcribePiece, isCanceled: (error) => error === "canceled",
    saveTranscript: async (_record, _app, segments) => { stored.push(segments); events.push("stored"); },
    freeBytes: async () => 10 * 1024 ** 3, now: () => clock, cancelRetryMs: 1, ...overrides
  });
}

async function startCall() {
  await service.initialize();
  audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }]);
  clock += 4_000;
  audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }, { id: "us.zoom.helper", input: false, output: true }]);
  await service.accept();
  expect(callState().recording).not.toBeNull();
}

async function writeRecord(progress: { done: number; segments: TranscriptSegment[] }, wavs = false) {
  const store = new CallStore(root);
  const record = newRecord(crypto.randomUUID(), "zoom", clock);
  record.status = "pending";
  record.endedAt = clock + 2_000;
  record.mic = progress;
  await store.create(record);
  if (wavs) {
    await writeFile(store.trackPath(record.id, "mic"), speechWav());
    await writeFile(store.trackPath(record.id, "system"), speechWav());
  }
  return record;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meluli-call-races-"));
  await mkdir(root, { recursive: true });
  clock = 1_000_000;
  audio = new FakeAudio();
  runtime = new FakeRuntime();
  events = [];
  stored = [];
  transcribePiece = vi.fn(async () => [{ start: 0, end: 1, text: "שלום" }]);
  service = build();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("delete-all against a call in progress", () => {
  it("waits for a transcript that is being stored", async () => {
    const save = gate();
    let entered = false;
    service = build({
      saveTranscript: async (_record, _app, segments) => {
        entered = true;
        await save.closed;
        stored.push(segments);
        events.push("stored");
      }
    });
    await startCall();
    await service.stop();
    await vi.waitFor(() => { expect(entered).toBe(true); });

    const clearing = service.clearAll().then(() => { events.push("cleared"); });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    save.open();
    await clearing;
    await flush();

    expect(events).toEqual(["stored", "cleared"]);
  });

  it("stores nothing from a record listed just before the delete", async () => {
    await writeRecord({ done: 1, segments: [{ start: 0, end: 1, text: "ישן" }] });
    const original = CallStore.prototype.list;
    let calls = 0;
    vi.spyOn(CallStore.prototype, "list").mockImplementation(async function (this: CallStore) {
      const records = await original.call(this);
      calls += 1;
      if (calls === 2) await service.clearAll();
      return records;
    });

    await service.initialize();
    await vi.waitFor(() => { expect(calls).toBeGreaterThanOrEqual(3); });
    await flush();

    expect(stored).toEqual([]);
  });

  it("drops a stop that is already in flight instead of saving after the delete", async () => {
    const stop = gate();
    await startCall();
    audio.stopGate = stop.closed;

    const stopping = service.stop().then(() => { events.push("stopped"); });
    await vi.waitFor(() => { expect(audio.stopEntered).toBe(true); });
    const clearing = service.clearAll().then(() => { events.push("cleared"); });
    await flush();
    stop.open();

    await expect(stopping).resolves.toBeUndefined();
    await clearing;
    await flush();

    expect(events).toEqual(["stopped", "cleared"]);
    expect(stored).toEqual([]);
    expect(callState().notice).toBeNull();
    expect(callState().failures).toEqual([]);
    await expect(readdir(root).catch(() => [])).resolves.toEqual([]);
  });

  it("stores nothing when a piece finishes after the delete", async () => {
    const piece = gate();
    let entered = false;
    transcribePiece.mockImplementation(async () => {
      entered = true;
      await piece.closed;
      return [{ start: 0, end: 1, text: "שלום" }];
    });
    await writeRecord({ done: 0, segments: [] }, true);
    await service.initialize();
    await vi.waitFor(() => { expect(entered).toBe(true); });

    await service.clearAll();
    piece.open();
    await flush();

    expect(stored).toEqual([]);
    expect(callState().failures).toEqual([]);
    await expect(readdir(root).catch(() => [])).resolves.toEqual([]);
  });

  it("goes back to work on what a failed delete left behind", async () => {
    const piece = gate();
    const clear = gate();
    let entered = false;
    transcribePiece.mockImplementation(async () => {
      entered = true;
      await piece.closed;
      return [{ start: 0, end: 1, text: "שלום" }];
    });
    await writeRecord({ done: 0, segments: [] }, true);
    await service.initialize();
    await vi.waitFor(() => { expect(entered).toBe(true); });
    vi.spyOn(CallStore.prototype, "clear").mockImplementation(async () => {
      await clear.closed;
      throw new Error("disk");
    });

    const clearing = expect(service.clearAll()).rejects.toThrow("disk");
    await flush();
    piece.open();
    await vi.waitFor(() => { expect(callState().processing).toBeNull(); });
    clear.open();
    await clearing;

    await vi.waitFor(() => { expect(stored).toHaveLength(1); });
  });

  it("still transcribes a call that arrives after the delete", async () => {
    await service.clearAll();
    await writeRecord({ done: 0, segments: [] }, true);
    await service.initialize();
    await vi.waitFor(() => { expect(stored).toHaveLength(1); });
  });
});

describe("shutdown and sleep against a stop in flight", () => {
  it("keeps the helper alive until the stop has finished", async () => {
    const stop = gate();
    await startCall();
    audio.stopGate = stop.closed;

    const stopping = service.stop();
    await vi.waitFor(() => { expect(audio.stopEntered).toBe(true); });
    const disposing = service.dispose();
    await flush();
    expect(audio.dispose).not.toHaveBeenCalled();

    stop.open();
    await stopping;
    await disposing;
    expect(audio.dispose).toHaveBeenCalledOnce();
  });

  it("suspend returns only once the stop has been saved", async () => {
    const stop = gate();
    await startCall();
    audio.stopGate = stop.closed;

    const stopping = service.stop();
    await vi.waitFor(() => { expect(audio.stopEntered).toBe(true); });
    const save = vi.spyOn(CallStore.prototype, "save");
    let suspended = false;
    let savesWhenDone = 0;
    const suspending = service.suspend().then(() => { suspended = true; savesWhenDone = save.mock.calls.length; });
    await flush();
    expect(suspended).toBe(false);

    stop.open();
    await Promise.all([stopping, suspending]);
    expect(savesWhenDone).toBeGreaterThan(0);
  });

  it("stops a second call that began while the first was saving", async () => {
    await startCall();
    const save = gate();
    const original = CallStore.prototype.save;
    let held = false;
    vi.spyOn(CallStore.prototype, "save").mockImplementation(async function (this: CallStore, record: CallRecord) {
      if (!held) {
        held = true;
        await save.closed;
      }
      return original.call(this, record);
    });

    const first = service.stop();
    await vi.waitFor(() => { expect(held).toBe(true); });
    // Stopping dismissed the app until its microphone really ended, so end it before the next call.
    audio.onApps!([]);
    clock += 60_000;
    audio.onApps!([]);
    audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }]);
    clock += 4_000;
    audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }, { id: "us.zoom.helper", input: false, output: true }]);
    await service.accept();
    expect(callState().recording).not.toBeNull();

    const second = service.stop();
    save.open();
    await Promise.all([first, second]);
    expect(callState().recording).toBeNull();
  });
});
