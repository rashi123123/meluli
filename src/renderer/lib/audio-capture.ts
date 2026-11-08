import type { RecordingAudioPayload } from "@shared/types";
import { MAX_RECORDING_DURATION_MS } from "@shared/constants";
import { he } from "@shared/locale";
import recorderWorkletUrl from "./audio-worklet.ts?worker&url";
import { CAPTURE_SAMPLE_RATE, mergeFloatChunks } from "./pcm";

/** The worklet confirms it handed over its last samples within this long of being told to stop. */
const FLUSH_ACK_TIMEOUT_MS = 1_000;


export class AudioCaptureController {
  private chunkListener: ((chunk: Float32Array) => void) | null = null;
  private strictFlush = false;
  setChunkListener(listener: ((chunk: Float32Array) => void) | null): void { this.chunkListener = listener; }
  setStrictFlush(enabled: boolean): void { this.strictFlush = enabled; }
  /** The chunks heard so far, in order (the stop payload is these merged). */
  capturedChunks(): readonly Float32Array[] { return this.chunks.slice(); }
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  private totalPausedMs = 0;
  private paused = false;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private generation = 0;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<RecordingAudioPayload> | null = null;
  private onFlushed: (() => void) | null = null;
  private reachedLimit = false;
  private stopping = false;

  constructor(private readonly onLimitReached?: () => void) {}

  get durationLimitReached(): boolean { return this.reachedLimit; }

  start(deviceId: string | null = null): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.audioContext) return Promise.resolve();
    const generation = ++this.generation;
    const task = this.startInternal(deviceId, generation).finally(() => {
      if (this.startTask === task) this.startTask = null;
    });
    this.startTask = task;
    return task;
  }

  private async startInternal(deviceId: string | null, generation: number): Promise<void> {
    const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (!deviceId || !["NotFoundError", "OverconstrainedError", "ConstraintNotSatisfiedError"].includes(name)) throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      }
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error(he.recordingFailed);
      }
      this.mediaStream = stream;
      this.stopping = false;
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (!this.stopping && generation === this.generation) this.onLimitReached?.();
        }, { once: true });
      }
      // After the input, on purpose: opening an output device alongside it delayed the
      // first sample by up to 600 ms, far longer than building this graph takes.
      const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      this.audioContext = context;
      await context.audioWorklet.addModule(recorderWorkletUrl);
      if (generation !== this.generation) throw new Error(he.recordingFailed);
      this.sourceNode = context.createMediaStreamSource(stream);
      this.workletNode = new AudioWorkletNode(context, "ivrit-recorder-processor");
      this.workletNode.onprocessorerror = () => {
        if (!this.stopping && generation === this.generation) this.onLimitReached?.();
      };
      this.workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data && typeof event.data === "object" && "type" in event.data && event.data.type === "flushed") {
          this.onFlushed?.();
          return;
        }
        if (!(event.data instanceof Float32Array) || this.reachedLimit) return;
        const remaining = Math.max(0, Math.floor(context.sampleRate * MAX_RECORDING_DURATION_MS / 1000) - this.sampleCount);
        const chunk = event.data.length <= remaining ? event.data : event.data.slice(0, remaining);
        if (chunk.length) {
          this.chunks.push(chunk); this.sampleCount += chunk.length;
          this.chunkListener?.(chunk);
        }
        if (chunk.length === remaining) {
          this.reachedLimit = true;
          this.sourceNode?.disconnect();
          this.mediaStream?.getTracks().forEach(track => track.stop());
          this.onLimitReached?.();
        }
      };
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(context.destination);
      // Global shortcuts do not provide a renderer click gesture. Explicitly
      // start a suspended context before reporting capture as ready.
      if (context.state === "suspended") await context.resume();
      if (generation !== this.generation) throw new Error(he.recordingFailed);
      this.startedAt = Date.now();
      this.pausedAt = 0; this.totalPausedMs = 0; this.paused = false;
    } catch (error) {
      if (generation === this.generation) await this.destroy();
      throw error;
    }
  }

  stop(): Promise<RecordingAudioPayload> {
    if (this.stopTask) return this.stopTask;
    const task = this.stopInternal().finally(() => { if (this.stopTask === task) this.stopTask = null; });
    this.stopTask = task;
    return task;
  }

  private async stopInternal(): Promise<RecordingAudioPayload> {
    const stopped = Date.now();
    if (this.startTask) await this.startTask;
    const context = this.audioContext;
    if (!context) throw new Error(he.recordingNotStarted);
    this.stopping = true;
    const micReady = this.startedAt;
    let flushIncomplete = false;
    try {
      // Disconnect input first, then wait for the worklet's final buffered samples.
      this.sourceNode?.disconnect();
      this.mediaStream?.getTracks().forEach(track => track.stop());
      if (context.state === "suspended") await context.resume();
      if (this.workletNode) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.onFlushed = null;
            if (this.strictFlush) reject(new Error("Experimental audio flush was not acknowledged; retained source may be incomplete."));
            else { flushIncomplete = true; resolve(); }
          }, FLUSH_ACK_TIMEOUT_MS);
          this.onFlushed = () => { clearTimeout(timeout); this.onFlushed = null; resolve(); };
          this.workletNode!.port.postMessage({ type: "stop" });
        });
      }
      const pcm = mergeFloatChunks(this.chunks, this.sampleCount);
      return {
        pcm, sampleRate: context.sampleRate, durationMs: pcm.length / context.sampleRate * 1000, capturedAt: { micReady, stopped },
        ...(flushIncomplete ? { flushIncomplete } : {})
      };
    } finally {
      await this.destroy();
    }
  }

  async pause(): Promise<void> {
    if (!this.audioContext || this.paused) return;
    await this.audioContext.suspend();
    this.pausedAt = Date.now(); this.paused = true;
  }

  async resume(): Promise<void> {
    if (!this.audioContext || !this.paused) return;
    await this.audioContext.resume();
    this.totalPausedMs += Date.now() - this.pausedAt;
    this.pausedAt = 0; this.paused = false;
  }

  getElapsedDurationMs(): number {
    if (!this.startedAt) return 0;
    const pausedOffset = this.paused && this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Math.max(0, Date.now() - this.startedAt - this.totalPausedMs - pausedOffset);
  }

  getMediaStream(): MediaStream | null { return this.mediaStream; }

  async destroy(): Promise<void> {
    ++this.generation;
    this.stopping = true;
    const worklet = this.workletNode, source = this.sourceNode, stream = this.mediaStream, context = this.audioContext;
    this.workletNode = null; this.sourceNode = null; this.mediaStream = null; this.audioContext = null;
    this.startTask = null; this.startedAt = 0; this.pausedAt = 0; this.totalPausedMs = 0; this.paused = false;
    this.chunks = []; this.sampleCount = 0; this.reachedLimit = false;
    this.onFlushed?.(); this.onFlushed = null;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      try { worklet.disconnect(); } catch { /* Already disconnected. */ }
    }
    try { source?.disconnect(); } catch { /* Already disconnected. */ }
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}
