/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationPreview } from "@shared/experimental-dictation";
import { LiveDictationService, PCM_HASH_SEED, finalTimeoutMs, hashPcm16, toPcm16 } from "@main/services/live-dictation.service";
import type { LiveChannel, LiveChannelListener } from "@main/services/transcription.service";
import type { LiveRequest, LiveWorkerMessage } from "@main/services/transcription-protocol";

const CHUNK = 2048;
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

/** A capture chunk with a recognisable ramp, so two chunks never hash alike. */
function chunk(index: number, length = CHUNK): Float32Array {
  const pcm = new Float32Array(length);
  for (let i = 0; i < length; i += 1) pcm[i] = Math.sin((index * length + i) / 50) * 0.3;
  return pcm;
}
function merge(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

let sent: LiveRequest[];
let listener: LiveChannelListener | null;
let openGate: { resolve: (channel: LiveChannel) => void; reject: (error: Error) => void } | null;
let accept: boolean;
let closed: number;
let previews: DictationPreview[];
let service: LiveDictationService;
let channel: LiveChannel;

beforeEach(() => {
  sent = []; listener = null; openGate = null; accept = true; closed = 0; previews = [];
  channel = { modelPath: "/models/zipformer/sherpa-onnx", send: (request) => { if (!accept) return false; sent.push(request); return true; }, close: () => { closed += 1; } };
  service = new LiveDictationService({
    open: (next) => { listener = next; return new Promise<LiveChannel>((resolve, reject) => { openGate = { resolve, reject }; }); },
    onPreview: (preview) => previews.push(preview),
    backend: () => "sherpa-onnx",
    modelId: () => "ivrit-ai/zipformer2-66m-streaming-he@test"
  });
});
afterEach(() => { vi.useRealTimers(); });

type WorkerMessage = LiveWorkerMessage extends infer M ? M extends LiveWorkerMessage ? Omit<M, "sessionId"> : never : never;
const worker = (message: WorkerMessage, id: string) =>
  listener!.message({ sessionId: id, ...message } as LiveWorkerMessage);
async function opened(id: string) {
  openGate!.resolve(channel);
  await flush();
  worker({ type: "begun" }, id);
}
const audio = () => sent.filter((r): r is Extract<LiveRequest, { type: "audio" }> => r.type === "audio");
const finishRequests = () => sent.filter(r => r.type === "finish");
const samplesOf = (request: Extract<LiveRequest, { type: "audio" }>) => Buffer.from(request.pcm, "base64").length / 2;
const finalMessage = (text: string, segments: string[]) => ({
  type: "final" as const, result: { text, language: "he", segments: segments.map((t, i) => ({ index: i, start: i, end: i + 1, text: t })) }, timing: { finishMs: 20 }
});

describe("live dictation", () => {
  it("buffers audio until the worker begins, then feeds it in order and sends only the unheard tail at stop", async () => {
    const id = service.begin();
    const chunks = [chunk(0), chunk(1), chunk(2)];
    service.append(id, 0, chunks[0]!);
    service.append(id, 1, chunks[1]!);
    expect(audio()).toHaveLength(0);
    await opened(id);
    expect(sent[0]).toMatchObject({ type: "begin", sessionId: id, modelPath: channel.modelPath });
    expect(audio().map(r => r.seq)).toEqual([0, 1]);
    service.append(id, 2, chunks[2]!);
    expect(audio().map(r => r.seq)).toEqual([0, 1, 2]);

    // The stop payload holds one more chunk the session has not heard (the worklet's flush).
    const tail = chunk(3, 700);
    const finishing = service.finish(merge([...chunks, tail]), 16_000);
    await flush();
    expect(audio().map(r => r.seq)).toEqual([0, 1, 2, 3]);
    expect(samplesOf(audio()[3]!)).toBe(700);
    expect(finishRequests()).toEqual([{ type: "finish", sessionId: id, samples: 3 * CHUNK + 700 }]);
    worker(finalMessage("שלום עולם", ["שלום עולם"]), id);
    await expect(finishing).resolves.toMatchObject({ text: "שלום עולם", backend: "sherpa-onnx", segments: [{ text: "שלום עולם" }] });
    expect(closed).toBe(1);
    expect(service.active).toBe(false);
  });

  it("keeps listening through pauses: segments become stable text and nothing ends until stop", async () => {
    const id = service.begin();
    await opened(id);
    for (let i = 0; i < 6; i += 1) service.append(id, i, chunk(i));
    worker({ type: "partial", seq: 1, text: "אני רוצה", segments: 0 }, id);
    worker({ type: "segment", segment: { index: 0, start: 0, end: 1.2, text: "אני רוצה לקבוע פגישה." } }, id);
    worker({ type: "partial", seq: 4, text: "ביום", segments: 1 }, id);
    worker({ type: "segment", segment: { index: 1, start: 2.4, end: 3.1, text: "ביום שלישי." } }, id);
    expect(previews.at(-1)).toMatchObject({ sessionId: id, stableText: "אני רוצה לקבוע פגישה. ביום שלישי.", text: "אני רוצה לקבוע פגישה. ביום שלישי." });
    expect(previews[2]).toMatchObject({ stableText: "אני רוצה לקבוע פגישה.", text: "אני רוצה לקבוע פגישה. ביום", decodedSamples: 5 * CHUNK });
    expect(finishRequests()).toHaveLength(0);
    expect(service.active).toBe(true);
  });

  it("stops before the worker opened: waits for it, then sends everything once", async () => {
    const id = service.begin();
    const chunks = [chunk(0), chunk(1)];
    chunks.forEach((c, i) => service.append(id, i, c));
    const finishing = service.finish(merge(chunks), 16_000);
    await flush();
    expect(audio()).toHaveLength(0);
    await opened(id);
    await flush();
    expect(audio().map(r => r.seq)).toEqual([0, 1]);
    expect(finishRequests()).toHaveLength(1);
    worker(finalMessage("כן", ["כן"]), id);
    await expect(finishing).resolves.toMatchObject({ text: "כן" });
  });

  it.each([
    ["a chunk out of order", (id: string) => { service.append(id, 0, chunk(0)); service.append(id, 2, chunk(2)); }, [chunk(0), chunk(1), chunk(2)]],
    ["audio that differs from the recording", (id: string) => { service.append(id, 0, chunk(9)); }, [chunk(0)]],
    ["a payload shorter than what was heard", (id: string) => { service.append(id, 0, chunk(0)); service.append(id, 1, chunk(1)); }, [chunk(0)]],
    ["a worker that dies", (id: string) => { service.append(id, 0, chunk(0)); listener!.lost(); }, [chunk(0)]],
    ["a worker error", (id: string) => { service.append(id, 0, chunk(0)); worker({ type: "error", code: "backpressure" }, id); }, [chunk(0)]],
    ["segments out of order", (id: string) => { service.append(id, 0, chunk(0)); worker({ type: "segment", segment: { index: 1, start: 0, end: 1, text: "x" } }, id); }, [chunk(0)]],
    ["a pipe that backs up", (id: string) => { accept = false; service.append(id, 0, chunk(0)); accept = true; }, [chunk(0)]]
  ])("falls back to a full decode after %s", async (_name, act, payload) => {
    const id = service.begin();
    await opened(id);
    act(id);
    await expect(service.finish(merge(payload), 16_000)).resolves.toBeNull();
    expect(finishRequests()).toHaveLength(0);
    expect(service.active).toBe(false);
  });

  it("falls back when the model cannot open, or the rate is not 16 kHz", async () => {
    let id = service.begin();
    service.append(id, 0, chunk(0));
    openGate!.reject(new Error("model missing"));
    await flush();
    await expect(service.finish(chunk(0), 16_000)).resolves.toBeNull();

    id = service.begin();
    await opened(id);
    service.append(id, 0, chunk(0));
    await expect(service.finish(chunk(0), 48_000)).resolves.toBeNull();
  });

  it("falls back on empty text, a worker error at finish, or no answer, and ignores a late answer", async () => {
    let id = service.begin();
    await opened(id);
    service.append(id, 0, chunk(0));
    let finishing = service.finish(chunk(0), 16_000);
    await flush();
    worker(finalMessage("", []), id);
    await expect(finishing).resolves.toBeNull();

    id = service.begin();
    await opened(id);
    service.append(id, 0, chunk(0));
    finishing = service.finish(chunk(0), 16_000);
    await flush();
    worker({ type: "error", code: "decode_failed" }, id);
    await expect(finishing).resolves.toBeNull();

    vi.useFakeTimers();
    id = service.begin();
    await opened(id);
    service.append(id, 0, chunk(0));
    finishing = service.finish(chunk(0), 16_000);
    await flush();
    await vi.advanceTimersByTimeAsync(finalTimeoutMs(CHUNK) + 1);
    await expect(finishing).resolves.toBeNull();
    expect(sent.at(-1)).toEqual({ type: "cancel_session", sessionId: id });
    const before = previews.length;
    worker(finalMessage("מאוחר", ["מאוחר"]), id);
    worker({ type: "partial", seq: 0, text: "מאוחר", segments: 0 }, id);
    expect(previews.length).toBe(before);
  });

  it("cancel tells the worker, ends a stop in progress, and later messages are ignored", async () => {
    const id = service.begin();
    await opened(id);
    service.append(id, 0, chunk(0));
    const finishing = service.finish(chunk(0), 16_000);
    await flush();
    service.cancel();
    await expect(finishing).resolves.toBeNull();
    expect(sent.filter(r => r.type === "cancel_session")).toEqual([{ type: "cancel_session", sessionId: id }]);
    worker({ type: "partial", seq: 0, text: "x", segments: 0 }, id);
    expect(previews).toHaveLength(0);
  });

  it("a new session replaces the last; the old session's chunks and text go nowhere", async () => {
    const first = service.begin();
    await opened(first);
    service.append(first, 0, chunk(0));
    const firstListener = listener!;
    const second = service.begin();
    expect(sent).toContainEqual({ type: "cancel_session", sessionId: first });
    service.append(first, 1, chunk(1));
    firstListener.message({ type: "partial", sessionId: first, seq: 0, text: "ישן", segments: 0 });
    await opened(second);
    service.append(second, 0, chunk(5));
    expect(audio().filter(r => r.sessionId === second).map(r => r.seq)).toEqual([0]);
    expect(audio().filter(r => r.sessionId === first)).toHaveLength(1);
    expect(previews).toHaveLength(0);
    const finishing = service.finish(chunk(5), 16_000);
    await flush();
    worker(finalMessage("חדש", ["חדש"]), second);
    await expect(finishing).resolves.toMatchObject({ text: "חדש" });
  });

  it("a stop with no session does nothing, and a second stop leaves the first to finish", async () => {
    await expect(service.finish(chunk(0), 16_000)).resolves.toBeNull();
    const id = service.begin();
    await opened(id);
    service.append(id, 0, chunk(0));
    const finishing = service.finish(chunk(0), 16_000);
    await flush();
    await expect(service.finish(chunk(0), 16_000)).resolves.toBeNull();
    worker(finalMessage("פעם אחת", ["פעם אחת"]), id);
    await expect(finishing).resolves.toMatchObject({ text: "פעם אחת" });
    expect(finishRequests()).toHaveLength(1);
  });

  it("converts and hashes the way the worker hears it", () => {
    expect(Array.from(toPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32767, 32767, -32768, 16384]);
    const a = toPcm16(chunk(0)), b = toPcm16(chunk(1));
    const whole = new Int16Array([...a, ...b]);
    expect(hashPcm16(hashPcm16(PCM_HASH_SEED, a), b)).toBe(hashPcm16(PCM_HASH_SEED, whole));
    expect(hashPcm16(PCM_HASH_SEED, a)).not.toBe(hashPcm16(PCM_HASH_SEED, b));
  });
});
