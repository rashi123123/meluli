import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStateSnapshot, CallState, TranscriptSegment } from "../../src/shared/types";
import { CallService, MAX_CALL_MS, type CallServiceDependencies } from "../../src/main/services/calls/call.service";
import type { CallAudioStopped } from "../../src/main/services/calls/call-audio.client";

class FakeRuntime extends EventEmitter {
  state = { status: "idle" } as AppStateSnapshot;
  getState() { return this.state; }
  updateState(next: Partial<AppStateSnapshot>) {
    this.state = { ...this.state, ...next };
    this.emit("state");
  }
}

/** One second of quiet noise with one second of speech in it. */
function speechWav(): Buffer {
  const samples = new Int16Array(32_000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index >= 8_000 && index < 24_000 ? (index % 2 ? 8_000 : -8_000) : (index % 2 ? 40 : -40);
  }
  return Buffer.concat([Buffer.alloc(44), Buffer.from(samples.buffer)]);
}

class FakeAudio {
  onApps: CallServiceDependencies["audio"]["onApps"] = null;
  onFault: CallServiceDependencies["audio"]["onFault"] = null;
  onGone: CallServiceDependencies["audio"]["onGone"] = null;
  watch = vi.fn();
  dispose = vi.fn();
  directory: string | null = null;
  startResult = true;
  async start(directory: string) {
    this.directory = directory;
    return this.startResult;
  }
  stopped: CallAudioStopped | null = { micOffsetMs: 0, systemOffsetMs: 0, systemHeard: true };
  tracks: Partial<Record<"mic" | "system", Buffer>> = { mic: speechWav(), system: speechWav() };
  async stop() {
    for (const [track, audio] of Object.entries(this.tracks)) await writeFile(join(this.directory!, `${track}.wav`), audio);
    return this.stopped;
  }
}

let root: string;
let clock: number;
let audio: FakeAudio;
let runtime: FakeRuntime;
let saved: TranscriptSegment[][];
let transcribePiece: ReturnType<typeof vi.fn<CallServiceDependencies["transcribePiece"]>>;
let service: CallService;

const callState = () => runtime.getState().call as CallState;
const settle = () => vi.waitFor(() => { expect(callState().processing).toBeNull(); });

function build(overrides: Partial<CallServiceDependencies> = {}) {
  return new CallService({
    audio: audio as never, runtime, root, isAvailable: () => true, isEnabled: () => true, requestMicrophone: async () => true,
    transcribePiece, isCanceled: (error) => error === "canceled",
    saveTranscript: async (_record, _app, segments) => { saved.push(segments); },
    freeBytes: async () => 10 * 1024 ** 3, now: () => clock, cancelRetryMs: 1, ...overrides
  });
}

async function startCall() {
  await service.initialize();
  audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }]);
  clock += 4_000;
  audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }, { id: "us.zoom.helper", input: false, output: true }]);
  await service.accept();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meluli-calls-"));
  clock = 1_000_000;
  audio = new FakeAudio();
  runtime = new FakeRuntime();
  saved = [];
  const lines = ["מישהו שואל שאלה", "ואני עונה לו"];
  transcribePiece = vi.fn(async (): Promise<TranscriptSegment[]> => [{ start: 0.1, end: 0.5, text: lines.shift() ?? "עוד שורה" }]);
  service = build();
});

afterEach(async () => {
  // A stopped call can still be writing its last file when processing clears.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("CallService", () => {
  it("only suggests until the user clicks", async () => {
    await service.initialize();
    audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }]);
    clock += 4_000;
    audio.onApps!([{ id: "us.zoom.xos", input: true, output: false }]);
    expect(callState().suggestion).toBe("zoom");
    expect(callState().recording).toBeNull();
    expect(audio.directory).toBeNull();
  });

  it("does not run below macOS 14.2", async () => {
    service = build({ isAvailable: () => false });
    await service.initialize();
    expect(audio.watch).toHaveBeenLastCalledWith(null);
  });

  it("does not suggest when the setting is off", async () => {
    service = build({ isEnabled: () => false });
    await service.initialize();
    expect(audio.watch).toHaveBeenLastCalledWith(null);
  });

  it("transcribes after the call ends, stores it and deletes the audio", async () => {
    await startCall();
    expect(callState().recording?.app).toBe("zoom");
    audio.onApps!([]);
    clock += 31_000;
    audio.onApps!([]);
    await vi.waitFor(() => { expect(saved).toHaveLength(1); });
    await settle();
    expect(saved[0]!.map((segment) => segment.speaker).sort()).toEqual(["me", "others"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("stops a call at the time limit", async () => {
    await startCall();
    clock += MAX_CALL_MS;
    audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }]);
    await vi.waitFor(() => { expect(callState().recording).toBeNull(); });
  });

  it("keeps the audio when transcription fails and resumes on retry", async () => {
    transcribePiece.mockResolvedValueOnce([{ start: 0, end: 1, text: "ראשון" }]).mockRejectedValueOnce(new Error("model"));
    await startCall();
    await service.stop();
    await vi.waitFor(() => { expect(callState().failures).toHaveLength(1); });
    await settle();
    const id = callState().failures[0]!.id;
    expect((await stat(join(root, id, "mic.wav"))).size).toBeGreaterThan(0);

    await service.retry(id);
    await vi.waitFor(() => { expect(saved).toHaveLength(1); });
    expect(transcribePiece).toHaveBeenCalledTimes(3);
    expect(saved[0]!.map((segment) => segment.text)).toEqual(expect.arrayContaining(["ראשון", "מישהו שואל שאלה"]));
  });

  it("repeats a piece that dictation took back, and waits for dictation to end", async () => {
    transcribePiece.mockRejectedValueOnce("canceled");
    await startCall();
    runtime.updateState({ status: "recording" });
    await service.stop();
    await vi.waitFor(() => { expect(callState().processing?.waiting).toBe(true); });
    expect(transcribePiece).not.toHaveBeenCalled();
    runtime.updateState({ status: "idle" });
    await vi.waitFor(() => { expect(saved).toHaveLength(1); });
    expect(transcribePiece).toHaveBeenCalledTimes(3);
  });

  it("reports a call with no speech and keeps nothing", async () => {
    const silence = Buffer.alloc(32_044);
    audio.tracks = { mic: silence, system: silence };
    await startCall();
    await service.stop();
    await vi.waitFor(() => { expect(callState().notice).toBe("no_speech"); });
    expect(transcribePiece).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("points at the permission when the call side stayed silent", async () => {
    audio.tracks = { mic: speechWav(), system: Buffer.alloc(32_044) };
    audio.stopped = { micOffsetMs: 0, systemOffsetMs: 0, systemHeard: false };
    await startCall();
    await service.stop();
    await vi.waitFor(() => { expect(callState().notice).toBe("others_silent"); });
  });

  it("records nothing when the microphone is refused", async () => {
    service = build({ requestMicrophone: async () => false });
    await startCall();
    expect(callState().notice).toBe("needs_microphone");
    expect(callState().recording).toBeNull();
    expect(audio.directory).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("does not offer a call the user stopped", async () => {
    await startCall();
    await service.stop();
    await settle();
    clock += 5_000;
    audio.onApps!([{ id: "us.zoom.xos", input: true, output: true }]);
    expect(callState().suggestion).toBeNull();
  });

  it("refuses to start without disk space", async () => {
    service = build({ freeBytes: async () => 1024 });
    await startCall();
    expect(callState().recording).toBeNull();
    expect(callState().notice).toBe("low_disk");
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the audio and offers nothing lost when the helper dies", async () => {
    await startCall();
    audio.stopped = null;
    audio.onGone!();
    await vi.waitFor(() => { expect(saved).toHaveLength(1); });
    await vi.waitFor(() => { expect(callState().notice).toBe("partial_audio"); });
  });

  it("picks up a call left by a crash", async () => {
    await startCall();
    const directory = audio.directory!;
    await audio.stop();
    service = build();
    await service.initialize();
    await vi.waitFor(() => { expect(saved).toHaveLength(1); });
    expect(directory).toContain(root);
  });

  it("leaves nothing behind after delete-all, even mid-recording", async () => {
    await startCall();
    await service.clearAll();
    expect(callState().recording).toBeNull();
    await expect(stat(root)).rejects.toThrow();
    expect(saved).toEqual([]);
  });

  it("stops and keeps the audio on sleep", async () => {
    await startCall();
    transcribePiece.mockImplementation(() => new Promise(() => undefined));
    await service.suspend();
    expect(callState().recording).toBeNull();
    await vi.waitFor(() => { expect(transcribePiece).toHaveBeenCalled(); });
    const [id] = await readdir(root);
    const record = JSON.parse(await readFile(join(root, id!, "call.json"), "utf8"));
    expect(record.status).toBe("pending");
  });
});
