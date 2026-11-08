// Live dictation on the streaming engine. The renderer's capture chunks are fed to the worker
// as they arrive; the worker closes a segment at each natural pause and keeps listening, so
// silence never ends or pastes anything. Only the person's stop does: the audio the worker has
// not yet heard is sent, the session is finished, and the text goes to the workflow once.
//
// Anything that would make the live text differ from the recording (a chunk out of order, a
// worker that fell behind or died, audio that does not match the stop payload) marks the
// session broken. `finish` then answers null and the caller decodes the whole recording
// instead, so a broken session costs time, never words.
import crypto from "node:crypto";
import type { DictationPreview } from "@shared/experimental-dictation";
import type { LiveChannel, LiveChannelListener } from "./transcription.service";
import { normalizeTranscriptionResult, type LiveWorkerMessage, type NormalizedTranscriptionResult } from "./transcription-protocol";

export const LIVE_SAMPLE_RATE = 16_000;
/** The worker's step; larger chunks are split so its sequence numbers stay small and regular. */
const WORKER_CHUNK_SAMPLES = 2048;
/** Audio held while the worker loads the model. Beyond this the session is decoded at stop. */
const MAX_BUFFERED_SAMPLES = 30 * LIVE_SAMPLE_RATE;
/** How long stop waits for a session that is still opening. */
const OPEN_WAIT_MS = 8_000;

/** Waiting for the final text: a floor, plus time for audio still queued in the worker. */
export function finalTimeoutMs(unsentSamples: number): number {
  return 4_000 + Math.ceil(unsentSamples / LIVE_SAMPLE_RATE) * 100;
}

export interface LiveDictationDependencies {
  open(listener: LiveChannelListener): Promise<LiveChannel>;
  onPreview(preview: DictationPreview): void;
  backend: () => NormalizedTranscriptionResult["backend"];
  modelId: () => string;
  /** Diagnostics only: what happened, never words. */
  log?: (event: string, details: Record<string, unknown>) => void;
}

/** Float [-1, 1] to s16, the conversion the worker reverses. */
export function toPcm16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.round(pcm[i]! * 32767);
    out[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
  }
  return out;
}

/** FNV-1a over s16 samples, so stop can prove the worker heard the start of this very recording. */
export function hashPcm16(hash: number, pcm: Int16Array): number {
  let h = hash >>> 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i]! & 0xffff;
    h ^= v & 0xff; h = Math.imul(h, 0x01000193);
    h ^= v >>> 8; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export const PCM_HASH_SEED = 0x811c9dc5;

type SessionState = "opening" | "open" | "broken" | "finishing" | "closed";

interface Session {
  id: string;
  state: SessionState;
  channel: LiveChannel | null;
  /** Settles when the worker has begun the session, or it broke first. */
  opened: Promise<void>;
  markOpened: () => void;
  /** The next renderer sequence number. */
  nextSequence: number;
  /** The next worker sequence number. */
  workerSeq: number;
  /** Samples received from the renderer, and their hash. */
  receivedSamples: number;
  hash: number;
  /** Samples handed to the worker; per worker seq, the total through it. */
  sentSamples: number;
  sentThrough: number[];
  buffered: Int16Array[];
  bufferedSamples: number;
  segments: string[];
  partial: string;
  decodedSamples: number;
  reason: string | null;
  final: ((message: LiveWorkerMessage | null) => void) | null;
}

export class LiveDictationService {
  private session: Session | null = null;

  constructor(private readonly dependencies: LiveDictationDependencies) {}

  get active(): boolean { return this.session !== null && this.session.state !== "closed"; }

  /** Starts a session and returns its id at once; the worker opens in the background. */
  begin(): string {
    this.drop("replaced");
    const id = crypto.randomUUID();
    let markOpened = () => {};
    const opened = new Promise<void>((resolve) => { markOpened = resolve; });
    const session: Session = {
      id, state: "opening", channel: null, opened, markOpened,
      nextSequence: 0, workerSeq: 0, receivedSamples: 0, hash: PCM_HASH_SEED, sentSamples: 0, sentThrough: [],
      buffered: [], bufferedSamples: 0, segments: [], partial: "", decodedSamples: 0, reason: null, final: null
    };
    this.session = session;
    this.dependencies.open({
      message: (message) => this.onMessage(session, message),
      lost: () => this.breakSession(session, "worker_lost")
    }).then((channel) => {
      if (this.session !== session || session.state === "closed") { channel.close(); return; }
      session.channel = channel;
      if (!channel.send({ type: "begin", sessionId: id, modelPath: channel.modelPath })) this.breakSession(session, "send_failed");
    }).catch(() => this.breakSession(session, "open_failed"));
    return id;
  }

  /** One capture chunk, in order. Chunks for any other session are stale and ignored. */
  append(sessionId: string, sequence: number, pcm: Float32Array): void {
    const session = this.session;
    if (!session || session.id !== sessionId || session.state === "closed" || session.state === "finishing") return;
    if (sequence !== session.nextSequence) { this.breakSession(session, "sequence"); return; }
    session.nextSequence += 1;
    const samples = toPcm16(pcm);
    session.receivedSamples += samples.length;
    session.hash = hashPcm16(session.hash, samples);
    if (session.state === "broken") return;
    if (session.state === "opening") {
      session.buffered.push(samples);
      session.bufferedSamples += samples.length;
      if (session.bufferedSamples > MAX_BUFFERED_SAMPLES) this.breakSession(session, "open_slow");
      return;
    }
    this.sendAudio(session, samples);
  }

  /**
   * Stop. Sends the recording's audio the worker has not heard, finishes the session, and
   * returns its text, or null when the recording must be decoded in full instead.
   */
  async finish(pcm: Float32Array, sampleRate: number): Promise<NormalizedTranscriptionResult | null> {
    const session = this.session;
    // One stop per session: a second one while the first waits leaves it alone.
    if (!session || session.state === "closed" || session.state === "finishing") return null;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    try {
      if (sampleRate !== LIVE_SAMPLE_RATE) this.breakSession(session, "sample_rate");
      if (session.state === "opening") await this.waitOpened(session);
      if (session.state !== "open") return null;
      // The payload is the same capture chunks merged, so its start must be exactly what the worker heard.
      const all = toPcm16(pcm);
      if (all.length < session.receivedSamples ||
        hashPcm16(PCM_HASH_SEED, all.subarray(0, session.receivedSamples)) !== session.hash) {
        this.breakSession(session, "payload_mismatch");
        return null;
      }
      if (session.receivedSamples < all.length) this.sendAudio(session, all.subarray(session.receivedSamples));
      if (session.state !== "open") return null;
      session.state = "finishing";
      const final = new Promise<LiveWorkerMessage | null>((resolve) => { session.final = resolve; });
      if (!session.channel?.send({ type: "finish", sessionId: session.id, samples: session.sentSamples })) return null;
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), finalTimeoutMs(all.length - session.decodedSamples)); });
      const message = await Promise.race([final, timeout]);
      if (!message || message.type !== "final") {
        this.log("finish_failed", { reason: message?.type === "error" ? message.code ?? "error" : "timeout" });
        return null;
      }
      finished = true;
      const normalized = normalizeTranscriptionResult(message);
      if (!normalized.text) return null;
      this.log("finished", {
        segments: normalized.segments?.length ?? 0, samples: all.length,
        finishMs: Date.now() - startedAt, workerFinishMs: message.timing?.finishMs ?? null
      });
      return { ...normalized, backend: this.dependencies.backend(), modelId: this.dependencies.modelId() };
    } finally {
      if (timer) clearTimeout(timer);
      // A worker that never answered is told to drop the session; its late text is ignored either way.
      this.drop(finished ? "finished" : session.reason ?? "abandoned", session);
    }
  }

  /** The person canceled, or the recording ended without audio. */
  cancel(): void { this.drop("canceled"); }

  private waitOpened(session: Session): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.breakSession(session, "open_timeout"); resolve(); }, OPEN_WAIT_MS);
      // `opened` only ever resolves (see open), so nothing is left unhandled.
      void session.opened.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  private sendAudio(session: Session, samples: Int16Array): void {
    const channel = session.channel;
    if (!channel) { this.breakSession(session, "no_channel"); return; }
    for (let offset = 0; offset < samples.length; offset += WORKER_CHUNK_SAMPLES) {
      const part = samples.subarray(offset, Math.min(samples.length, offset + WORKER_CHUNK_SAMPLES));
      const pcm = Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64");
      if (!channel.send({ type: "audio", sessionId: session.id, seq: session.workerSeq, pcm })) {
        this.breakSession(session, "backpressure");
        return;
      }
      session.workerSeq += 1;
      session.sentSamples += part.length;
      session.sentThrough.push(session.sentSamples);
    }
  }

  private onMessage(session: Session, message: LiveWorkerMessage): void {
    if (this.session !== session || message.sessionId !== session.id) return;
    switch (message.type) {
      case "begun": {
        if (session.state !== "opening") return;
        session.state = "open";
        const buffered = session.buffered;
        session.buffered = []; session.bufferedSamples = 0;
        for (const samples of buffered) {
          this.sendAudio(session, samples);
          if (session.state !== "open") break;
        }
        session.markOpened();
        return;
      }
      case "partial":
        session.partial = message.text;
        session.decodedSamples = session.sentThrough[message.seq] ?? session.decodedSamples;
        this.preview(session);
        return;
      case "segment":
        // Segments arrive once each, in order; a finalized segment is never revisited.
        if (message.segment.index !== session.segments.length) { this.breakSession(session, "segment_order"); return; }
        session.segments.push(message.segment.text);
        session.partial = "";
        this.preview(session);
        return;
      case "final":
        session.final?.(message);
        session.final = null;
        return;
      case "canceled":
        session.final?.(null);
        session.final = null;
        return;
      case "error":
        this.log("worker_error", { code: message.code ?? null, state: session.state });
        if (session.state === "finishing") { session.final?.(message); session.final = null; }
        this.breakSession(session, message.code ?? "worker_error");
        return;
    }
  }

  private preview(session: Session): void {
    if (session.state === "broken" || session.state === "closed") return;
    const stableText = session.segments.join(" ");
    const text = [stableText, session.partial].filter(Boolean).join(" ");
    this.dependencies.onPreview({
      sessionId: session.id, text, stableText,
      audioSamples: session.receivedSamples, decodedSamples: session.decodedSamples
    });
  }

  private breakSession(session: Session, reason: string): void {
    if (session.state === "closed" || session.state === "broken") return;
    const wasFinishing = session.state === "finishing";
    session.state = "broken";
    session.reason = reason;
    session.buffered = []; session.bufferedSamples = 0;
    this.log("session_broken", { reason });
    if (wasFinishing) { session.final?.(null); session.final = null; }
    session.channel?.send({ type: "cancel_session", sessionId: session.id });
    session.markOpened();
  }

  private drop(reason: string, only?: Session): void {
    const session = this.session;
    if (!session || (only && session !== only)) return;
    this.session = null;
    if (session.state !== "closed") {
      if (session.state !== "broken" && reason !== "finished") session.channel?.send({ type: "cancel_session", sessionId: session.id });
      session.state = "closed";
    }
    session.final?.(null);
    session.final = null;
    session.channel?.close();
    session.markOpened();
  }

  private log(event: string, details: Record<string, unknown>): void { this.dependencies.log?.(event, details); }
}
