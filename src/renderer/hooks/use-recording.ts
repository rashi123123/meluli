import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MicrophonePermissionStatus, RecordingAudioPayload, TranscriptRecord } from "@shared/types";
import type { AppWindowRole } from "@shared/window-role";
import { useKeepMainWindow } from "@/lib/keep-main-window";
import { CANCEL_UNDO_MIN_MS, HELD_RECORDING_TTL_MS, MIN_DICTATION_MS } from "@shared/constants";
import { getHebrewErrorMessage, isCanceledMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import { AudioCaptureController } from "@/lib/audio-capture";
import { CAPTURE_SAMPLE_RATE, mergeFloatChunks } from "@/lib/pcm";
import { playCue } from "@/lib/sounds";
import type { DictationPreview } from "@shared/experimental-dictation";

/** The windows that can own a recording. */
type RecordingWindowMode = Exclude<AppWindowRole, "call">;
type RecordingCommand = "pause" | "resume" | "stop" | "cancel";

const RECORDING_OWNER_STORAGE_KEY = "ivrit-recording-owner";
const RECORDING_CONTROL_CHANNEL = "ivrit-recording-control";
const HELD_EXPIRY_CHECK_MS = 30_000;
/** Audio goes to disk about once a second, so a crash loses at most that much. */
const SPOOL_CHUNK_SAMPLES = CAPTURE_SAMPLE_RATE;

/** The copy of one recording that main writes to disk while it lasts. */
interface AudioSpool {
  id: string;
  sequence: number;
  buffer: Float32Array[];
  buffered: number;
  /** Chunks wait until main has given this window the recording. */
  ready: boolean;
  /** Main refused a chunk, so the rest would not line up. */
  broken: boolean;
  /** Main answered that it keeps audio on disk in this run. */
  stored: boolean;
  /** Nothing is left behind in this window: the last chunk went too, or main got the whole recording to keep in place of the chunks. */
  whole: boolean;
  pending: Promise<void>;
}

/** `crypto.randomUUID` needs a secure context; random bytes do not. */
function newRecordingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A finished recording that has no transcript yet. It lives only in this window's memory. */
export interface HeldRecording {
  reason: "failed" | "canceled";
  durationMs: number;
}

interface UseRecordingOptions {
  windowMode: RecordingWindowMode;
  timerStartedAt: number | null;
  microphoneDeviceId: string | null;
  permissionStatus: MicrophonePermissionStatus;
  requestPermission: () => Promise<unknown>;
  onStart?: () => void | Promise<void>;
  onTranscript: (transcript: TranscriptRecord) => void;
  onError: (message: string) => void;
  onDurationLimit?: () => void;
}

function readRecordingOwner(): RecordingWindowMode | null {
  const value = window.localStorage.getItem(RECORDING_OWNER_STORAGE_KEY);
  return value === "main" || value === "overlay" ? value : null;
}

/**
 * Sends one capture chunk to the live session, chained after the last so main hears them in
 * order. A chunk main could not take only ends the live text: the stop payload still carries the
 * whole recording, which main then decodes in full.
 */
function forwardLiveChunk(session: { id: string; sequence: number; pending: Promise<void>; dead: boolean } | null, pcm: Float32Array): void {
  if (!session || session.dead) return;
  const sequence = session.sequence++;
  session.pending = session.pending
    .then(() => window.ivritMenuBar.recording.experimentalChunk!({ sessionId: session.id, sequence, pcm }))
    .catch(() => { session.dead = true; });
}

export function useRecording({
  windowMode,
  timerStartedAt,
  microphoneDeviceId,
  permissionStatus,
  requestPermission,
  onStart,
  onTranscript,
  onError,
  onDurationLimit
}: UseRecordingOptions) {
  const controllerRef = useRef<AudioCaptureController | null>(null);
  const commandChannelRef = useRef<BroadcastChannel | null>(null);
  const ownerRef = useRef<RecordingWindowMode | null>(null);
  const stopInFlightRef = useRef(false);
  const startInFlightRef = useRef(false);
  const startTaskRef = useRef<Promise<void> | null>(null);
  const pressedAtRef = useRef(0);
  /** Which press a held key owns, so its release cannot end a recording it did not begin. */
  const holdPressRef = useRef<number | null>(null);
  const stopAfterStartRef = useRef(false);
  const deliveryRef = useRef<Promise<void> | null>(null);
  const cancelRequestedRef = useRef(false);
  /** True until the microphone has handed over the audio: nothing has reached the engine yet. */
  const flushingRef = useRef(false);
  const stopTaskRef = useRef<Promise<void> | null>(null);
  const heldPayloadRef = useRef<RecordingAudioPayload | null>(null);
  const heldTimerRef = useRef<number | null>(null);
  /** Weak, so remembering when audio expires never keeps the audio itself in memory. */
  const heldExpiryRef = useRef(new WeakMap<RecordingAudioPayload, number>());
  const [heldRecording, setHeldRecording] = useState<HeldRecording | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const mockModeRef = useRef(false);
  const experimentRef = useRef<{ id: string; sequence: number; pending: Promise<void> } | null>(null);
  /** The streaming engine's live session: every capture chunk goes to main as it arrives. */
  const liveRef = useRef<{ id: string; sequence: number; pending: Promise<void>; dead: boolean } | null>(null);
  const archiveFailedRef = useRef(false);
  const spoolRef = useRef<AudioSpool | null>(null);
  /** Weak, like the expiry times: it only says whether a held recording also waits on disk. */
  const spoolOfPayloadRef = useRef(new WeakMap<RecordingAudioPayload, AudioSpool>());
  const [livePreview, setLivePreview] = useState<DictationPreview | null>(null);

  const claimOwnership = () => {
    ownerRef.current = windowMode;
    window.localStorage.setItem(RECORDING_OWNER_STORAGE_KEY, windowMode);
  };

  const releaseOwnership = () => {
    if (ownerRef.current !== windowMode) {
      return;
    }

    ownerRef.current = null;
    if (readRecordingOwner() === windowMode) {
      window.localStorage.removeItem(RECORDING_OWNER_STORAGE_KEY);
    }
  };

  const dropHeldRecording = () => {
    heldPayloadRef.current = null;
    if (heldTimerRef.current !== null) window.clearTimeout(heldTimerRef.current);
    heldTimerRef.current = null;
    setHeldRecording(null);
  };

  const expireHeldRecording = (reason: HeldRecording["reason"] | undefined, payload: RecordingAudioPayload | null) => {
    dropHeldRecording();
    const onDisk = payload ? spoolOfPayloadRef.current.get(payload)?.stored === true : false;
    if (reason === "failed") onError(onDisk ? he.recordingHeldSaved : he.recordingHeldExpired);
  };

  const flushSpool = (spool: AudioSpool) => {
    if (!spool.buffered || spool.broken || !spool.ready) return;
    const pcm = mergeFloatChunks(spool.buffer, spool.buffered);
    spool.buffer = [];
    spool.buffered = 0;
    const sequence = spool.sequence++;
    const send = window.ivritMenuBar.recording.audioChunk;
    if (!send) { spool.broken = true; return; }
    spool.pending = spool.pending
      .then(() => send({ recordingId: spool.id, sequence, sampleRate: CAPTURE_SAMPLE_RATE, pcm }))
      .then((stored) => {
        if (stored) spool.stored = true;
        // Nothing is kept on disk in this run, so the rest need not go.
        else spool.broken = true;
      })
      // The whole recording still goes to main when it ends; only the crash copy is short.
      .catch(() => { spool.broken = true; });
  };

  /** The copy on disk holds all of this recording, so the audio in memory may go. */
  const spoolKeepsAll = (spool: AudioSpool | undefined) => Boolean(spool?.stored && spool.whole && !spool.broken);

  /** Ends this window's part in the copy on disk and returns it, if there was one. */
  const takeSpool = (): AudioSpool | null => {
    const spool = spoolRef.current;
    spoolRef.current = null;
    return spool;
  };

  /** The recording was thrown away, so the copy on disk goes too. */
  const stopRecordingRuntime = async (spool: AudioSpool | null) => {
    await spool?.pending;
    await window.ivritMenuBar.recording.stop(spool ? { recordingId: spool.id } : undefined);
  };

  /** Timers stop while the Mac sleeps, so after a wake only the clock knows how long it has been. */
  const watchHeldExpiry = (payload: RecordingAudioPayload, reason: HeldRecording["reason"]) => {
    const remainingMs = heldExpiryRef.current.get(payload)! - Date.now();
    if (remainingMs <= 0) {
      expireHeldRecording(reason, payload);
      return;
    }
    heldTimerRef.current = window.setTimeout(() => watchHeldExpiry(payload, reason), Math.min(remainingMs, HELD_EXPIRY_CHECK_MS));
  };

  /** A failed retry holds the same audio again, which does not buy it more time. */
  const holdRecording = (payload: RecordingAudioPayload, reason: HeldRecording["reason"]) => {
    dropHeldRecording();
    heldExpiryRef.current.set(payload, heldExpiryRef.current.get(payload) ?? Date.now() + HELD_RECORDING_TTL_MS);
    heldPayloadRef.current = payload;
    setHeldRecording({ reason, durationMs: payload.durationMs });
    watchHeldExpiry(payload, reason);
  };

  useEffect(() => {
    if (windowMode === "overlay") void window.ivritMenuBar.overlay?.setHeldRecording?.(heldRecording?.reason ?? null);
  }, [heldRecording?.reason, windowMode]);
  // Held audio lives only in this renderer, so a main window holding it must not be released.
  useKeepMainWindow(windowMode === "main" && heldRecording !== null);

  useEffect(() => {
    controllerRef.current = new AudioCaptureController(() => {
      if (controllerRef.current?.durationLimitReached) {
        onDurationLimit?.();
        void stopRecordingLocal();
        return;
      }
      void interruptRecordingLocal(he.microphoneDisconnected);
    });
    controllerRef.current.setChunkListener((pcm) => {
      const spool = spoolRef.current;
      if (spool && !spool.broken) {
        spool.buffer.push(pcm);
        spool.buffered += pcm.length;
        if (spool.buffered >= SPOOL_CHUNK_SAMPLES) flushSpool(spool);
      }
      forwardLiveChunk(liveRef.current, pcm);
      const session = experimentRef.current;
      if (!session) return;
      const sequence = session.sequence++;
      session.pending = session.pending.then(() => window.ivritMenuBar.recording.experimentalChunk!({ sessionId: session.id, sequence, pcm }));
      // Attach a rejection observer immediately. Preserve the rejected chain so
      // later chunks cannot skip a failed frame; full audio remains in capture.
      void session.pending.catch(() => {
        if (archiveFailedRef.current) return;
        archiveFailedRef.current = true;
        onError("שמירת האודיו הניסיונית נכשלה. ההקלטה נעצרת ונשמר עותק מלא לשחזור ככל שהאחסון זמין.");
        if (!startInFlightRef.current) void stopRecordingLocal();
      });
    });
    const unsubscribe = window.ivritMenuBar.recording.onExperimentalPreview?.((preview) => {
      if (preview.sessionId === experimentRef.current?.id || preview.sessionId === liveRef.current?.id) setLivePreview(preview);
    });
    commandChannelRef.current = new BroadcastChannel(RECORDING_CONTROL_CHANNEL);

    return () => {
      unsubscribe?.();
      releaseOwnership();
      dropHeldRecording();
      commandChannelRef.current?.close();
      commandChannelRef.current = null;
      void controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [windowMode]);

  const startRecordingLocal = useEffectEvent(async () => {
    if (startInFlightRef.current || stopInFlightRef.current || ownerRef.current === windowMode) return;
    startInFlightRef.current = true;
    let settleStart = () => {};
    startTaskRef.current = new Promise<void>((resolve) => { settleStart = resolve; });
    archiveFailedRef.current = false;
    stopAfterStartRef.current = false;
    cancelRequestedRef.current = false;
    dropHeldRecording();
    const startedAt = Date.now();
    pressedAtRef.current = startedAt;
    let runtimeStarted = false;
    const stopIfCanceled = () => { if (cancelRequestedRef.current) throw new Error(he.recordingFailed); };
    // Opened before the microphone, which may start hearing speech before main answers.
    const spool: AudioSpool = {
      id: newRecordingId(), sequence: 0, buffer: [], buffered: 0,
      ready: false, broken: false, stored: false, whole: false, pending: Promise.resolve()
    };
    spoolRef.current = spool;

    try {
      setIsPreparing(true);
      mockModeRef.current = await window.ivritMenuBar.app.isMockMode();
      // Main may wait on a slow target app. Speech must not wait with it, so the microphone
      // opens now whenever nothing has to be asked first; research sessions keep their order.
      const archiving = await window.ivritMenuBar.recording.experimentalEnabled?.();
      if (!mockModeRef.current && permissionStatus === "granted" && !archiving) {
        void controllerRef.current?.start(microphoneDeviceId).catch(() => undefined);
      }
      await window.ivritMenuBar.recording.start(startedAt);
      runtimeStarted = true;
      claimOwnership();
      // Research runs archive the audio their own way, and the mock has no microphone.
      if (archiving || mockModeRef.current) { if (spoolRef.current === spool) spoolRef.current = null; }
      else { spool.ready = true; if (spool.buffered >= SPOOL_CHUNK_SAMPLES) flushSpool(spool); }
      stopIfCanceled();

      if (permissionStatus !== "granted") {
        await requestPermission();
      }
      if (!mockModeRef.current) {
        const experiment = await window.ivritMenuBar.recording.experimentalBegin?.();
        const live = experiment?.live === true;
        experimentRef.current = experiment && !live ? { id: experiment.sessionId, sequence: 0, pending: Promise.resolve() } : null;
        liveRef.current = experiment && live ? { id: experiment.sessionId, sequence: 0, pending: Promise.resolve(), dead: false } : null;
        // Audio the microphone heard before the session opened goes first, in order.
        for (const pcm of live ? controllerRef.current?.capturedChunks() ?? [] : []) forwardLiveChunk(liveRef.current, pcm);
        controllerRef.current?.setStrictFlush(Boolean(experiment) && !live);
        setLivePreview(null);
        await controllerRef.current?.start(microphoneDeviceId);
        setMediaStream(controllerRef.current?.getMediaStream() ?? null);
      } else {
        setMediaStream(null);
      }
      stopIfCanceled();
      void playCue("start").catch(() => undefined);
      await onStart?.();
    } catch (error) {
      const started = spoolRef.current === spool ? takeSpool() : null;
      if (runtimeStarted) {
        await stopRecordingRuntime(started).catch(() => undefined);
      }
      await controllerRef.current?.destroy();
      releaseOwnership();
      setMediaStream(null);
      if (!cancelRequestedRef.current) onError(getHebrewErrorMessage(error, he.recordingFailed));
    } finally {
      startInFlightRef.current = false;
      setIsPreparing(false);
      settleStart();
      if ((archiveFailedRef.current || stopAfterStartRef.current) && ownerRef.current === windowMode) void stopRecordingLocal();
    }
  });

  /** One attempt to turn captured audio into text. A failed attempt keeps the audio for a retry. */
  const deliverAudio = useEffectEvent((payload: RecordingAudioPayload) => {
    const delivery = attemptDelivery(payload).finally(() => {
      if (deliveryRef.current === delivery) deliveryRef.current = null;
    });
    deliveryRef.current = delivery;
    return delivery;
  });

  const attemptDelivery = useEffectEvent(async (payload: RecordingAudioPayload) => {
    try {
      const transcript = await window.ivritMenuBar.recording.sendAudio(payload);
      dropHeldRecording();
      onTranscript(transcript);
    } catch (error) {
      const message = getHebrewErrorMessage(error, he.stopRecordingFailed);
      if (isCanceledMessage(message)) {
        // Whatever the length, canceling while waiting comes after the speech is finished.
        if (windowMode === "overlay") holdRecording(payload, "canceled");
        else dropHeldRecording();
        return;
      }

      // Silence is a result, not a failure: the same audio would give the same answer.
      if (message === he.transcriptionEmptyResult) dropHeldRecording();
      else holdRecording(payload, "failed");
      await window.ivritMenuBar.recording.stop().catch(() => undefined);
      onError(message);
    }
  });

  const finishRecording = (): Promise<RecordingAudioPayload | undefined> => mockModeRef.current
    ? Promise.resolve({
        pcm: Float32Array.from({ length: 8_000 }, (_, index) => Math.sin(index / 14) * 0.008),
        sampleRate: CAPTURE_SAMPLE_RATE,
        durationMs: 1_500
      })
    : controllerRef.current?.stop() ?? Promise.resolve(undefined);

  // Anything shorter is a slip of the finger; anything longer may have been speech nobody heard.
  const pressLookedDeliberate = () => Date.now() - pressedAtRef.current >= MIN_DICTATION_MS;

  /** The shortcut came back before the microphone opened. Returns whether a message explains it. */
  const abandonStartLocal = useEffectEvent(async () => {
    const unheard = pressLookedDeliberate();
    await cancelRecordingLocal();
    if (unheard) onError(he.microphoneOpenedTooLate);
    return unheard;
  });

  const stopRecordingLocal = useEffectEvent(async () => {
    if (startInFlightRef.current) {
      await abandonStartLocal();
      return;
    }

    if (stopInFlightRef.current || ownerRef.current !== windowMode) {
      return;
    }

    stopInFlightRef.current = true;
    cancelRequestedRef.current = false;
    flushingRef.current = true;
    let settleStop = () => {};
    stopTaskRef.current = new Promise<void>((resolve) => { settleStop = resolve; });
    let spool: AudioSpool | null = null;
    try {
      const payload = await finishRecording().finally(() => { flushingRef.current = false; });
      spool = takeSpool();
      setMediaStream(null);
      releaseOwnership();
      if (cancelRequestedRef.current) {
        const keepForUndo = windowMode === "overlay" && !experimentRef.current;
        if (keepForUndo && payload && payload.durationMs >= CANCEL_UNDO_MIN_MS) {
          if (spool) payload.recordingId = spool.id;
          holdRecording(payload, "canceled");
        }
        await experimentRef.current?.pending.catch(() => undefined);
        await stopRecordingRuntime(spool);
        return;
      }
      if (!payload || payload.durationMs < MIN_DICTATION_MS) {
        // A brushed shortcut never reaches the engine, which can only guess at so little audio.
        await stopRecordingRuntime(spool);
        if (pressLookedDeliberate()) onError(he.recordingTooShort);
        else if (windowMode === "overlay") await window.ivritMenuBar.overlay?.hide();
        return;
      }

      void playCue("stop").catch(() => undefined);
      // Main's finish path also verifies that the archived PCM equals this
      // complete payload. A failed chunk must not prevent preserving the source.
      await experimentRef.current?.pending.catch(() => undefined);
      // Every live chunk reaches main before the stop, which sends only what the session has not heard.
      await liveRef.current?.pending.catch(() => undefined);
      // Main replaces the copy it has been writing with this whole recording.
      if (spool) {
        payload.recordingId = spool.id;
        spool.whole = true;
        spoolOfPayloadRef.current.set(payload, spool);
      }
      await deliverAudio(payload);
    } catch (error) {
      spool ??= takeSpool();
      releaseOwnership();
      if (isCanceledMessage(getHebrewErrorMessage(error, he.stopRecordingFailed))) {
        return;
      }

      await stopRecordingRuntime(spool).catch(() => undefined);
      if (!cancelRequestedRef.current) onError(getHebrewErrorMessage(error, he.stopRecordingFailed));
    } finally {
      experimentRef.current = null;
      liveRef.current = null;
      stopInFlightRef.current = false;
      settleStop();
    }
  });

  const cancelRecordingLocal = useEffectEvent(async () => {
    if (stopInFlightRef.current) {
      // Once the audio has been sent, canceling belongs to the processing path and its undo.
      if (!flushingRef.current) return;
      cancelRequestedRef.current = true;
      await stopTaskRef.current;
      return;
    }
    if (startInFlightRef.current) {
      cancelRequestedRef.current = true;
      await controllerRef.current?.destroy();
      await startTaskRef.current;
      return;
    }

    if (ownerRef.current !== windowMode) return;
    cancelRequestedRef.current = true;
    try {
      // The floating window offers a moment to undo; the audio goes no further than this memory.
      const keepForUndo = windowMode === "overlay" && !experimentRef.current;
      const spool = takeSpool();
      if (experimentRef.current || keepForUndo) {
        const payload = await finishRecording().catch(() => undefined);
        if (keepForUndo && payload && payload.durationMs >= CANCEL_UNDO_MIN_MS) {
          // Undo sends it again under the same id; the copy on disk goes now either way.
          if (spool) payload.recordingId = spool.id;
          holdRecording(payload, "canceled");
        }
      } else await controllerRef.current?.destroy();
      await experimentRef.current?.pending.catch(() => undefined);
      await stopRecordingRuntime(spool);
    } finally { experimentRef.current = null; liveRef.current = null; setLivePreview(null); releaseOwnership(); setMediaStream(null); }
  });

  /** The recording ended without anyone asking: keep the audio and say so, but paste nothing. */
  const interruptRecordingLocal = useEffectEvent(async (message: string) => {
    if (startInFlightRef.current) { await cancelRecordingLocal(); return; }
    if (stopInFlightRef.current || ownerRef.current !== windowMode || experimentRef.current) {
      if (experimentRef.current) await stopRecordingLocal();
      return;
    }
    stopInFlightRef.current = true;
    try {
      const payload = await finishRecording().catch(() => undefined);
      const spool = takeSpool();
      if (spool) {
        // The last second has not gone to disk yet; main keeps what it has as a failed recording.
        flushSpool(spool);
        await spool.pending;
        spool.whole = spool.buffered === 0;
        if (payload) { payload.recordingId = spool.id; spoolOfPayloadRef.current.set(payload, spool); }
      }
      if (payload && payload.durationMs >= MIN_DICTATION_MS) holdRecording(payload, "failed");
      await window.ivritMenuBar.recording.stop(spool ? { recordingId: spool.id, keepAudio: true } : undefined).catch(() => undefined);
      onError(message);
    } finally {
      setMediaStream(null); releaseOwnership();
      stopInFlightRef.current = false;
    }
  });

  // The floating window hears this through its HUD; a recording here has no HUD to hear it.
  useEffect(() => windowMode === "main"
    ? window.ivritMenuBar.app.onRecordingInterruptRequested?.(() => { void interruptRecordingLocal(he.recordingInterrupted); })
    : undefined, [windowMode]);

  /** Stops the engine and waits to learn whether the audio is held for Undo. */
  const cancelProcessingLocal = useEffectEvent(async () => {
    const canceled = await window.ivritMenuBar.transcription.cancel();
    await deliveryRef.current;
    return { canceled, held: heldPayloadRef.current !== null };
  });

  /** Sends held audio again. Pasting needs a target, so the overlay takes the current one first. */
  const resendHeldRecordingLocal = useEffectEvent(async () => {
    const payload = heldPayloadRef.current;
    if (!payload || startInFlightRef.current || stopInFlightRef.current || ownerRef.current === windowMode) return;
    if ((heldExpiryRef.current.get(payload) ?? 0) <= Date.now()) {
      expireHeldRecording(heldRecording?.reason, payload);
      return;
    }
    stopInFlightRef.current = true;
    // The payload stays until delivery settles, so a failure can hold it again.
    if (heldTimerRef.current !== null) window.clearTimeout(heldTimerRef.current);
    heldTimerRef.current = null;
    setHeldRecording(null);
    setIsResending(true);
    try {
      if (windowMode === "overlay") await window.ivritMenuBar.overlay.retarget();
      await window.ivritMenuBar.recording.start(Date.now());
      await deliverAudio(payload);
    } catch (error) {
      if (heldPayloadRef.current === payload) holdRecording(payload, "failed");
      onError(getHebrewErrorMessage(error, he.stopRecordingFailed));
    } finally {
      stopInFlightRef.current = false;
      setIsResending(false);
    }
  });

  const pauseRecordingLocal = useEffectEvent(async () => {
    try {
      const elapsedMs = controllerRef.current?.getElapsedDurationMs() ?? 0;
      await controllerRef.current?.pause();
      await window.ivritMenuBar.recording.pause(elapsedMs);
    } catch (error) {
      onError(getHebrewErrorMessage(error, he.pauseRecordingFailed));
    }
  });

  const resumeRecordingLocal = useEffectEvent(async () => {
    try {
      const elapsedMs = timerStartedAt ?? controllerRef.current?.getElapsedDurationMs() ?? 0;
      await controllerRef.current?.resume();
      await window.ivritMenuBar.recording.start(Date.now() - elapsedMs);
    } catch (error) {
      onError(getHebrewErrorMessage(error, he.resumeRecordingFailed));
    }
  });

  const dispatchCommandToOwner = useEffectEvent((command: RecordingCommand) => {
    const owner = readRecordingOwner();
    if (!owner) {
      return;
    }

    if (owner === windowMode) {
      void (
        command === "cancel"
          ? cancelRecordingLocal()
          : command === "pause"
          ? pauseRecordingLocal()
          : command === "resume"
            ? resumeRecordingLocal()
            : stopRecordingLocal()
      );
      return;
    }

    commandChannelRef.current?.postMessage({
      type: "recording-command",
      target: owner,
      command
    });
  });

  useEffect(() => {
    const channel = commandChannelRef.current;
    if (!channel) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; target?: RecordingWindowMode; command?: RecordingCommand };
      if (payload.type !== "recording-command" || payload.target !== windowMode) {
        return;
      }

      if (payload.command === "cancel") {
        void cancelRecordingLocal();
        return;
      }

      if (payload.command === "pause") {
        void pauseRecordingLocal();
        return;
      }

      if (payload.command === "resume") {
        void resumeRecordingLocal();
        return;
      }

      if (payload.command === "stop") {
        void stopRecordingLocal();
      }
    };

    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
    };
  }, [cancelRecordingLocal, pauseRecordingLocal, resumeRecordingLocal, stopRecordingLocal, windowMode]);

  const startRecording = useEffectEvent(async () => {
    await startRecordingLocal();
  });

  const beginHold = useEffectEvent(() => {
    if (startInFlightRef.current || stopInFlightRef.current || ownerRef.current === windowMode) return false;
    void startRecordingLocal();
    holdPressRef.current = pressedAtRef.current;
    return true;
  });

  const endHold = useEffectEvent(() => {
    const ownsPress = holdPressRef.current === pressedAtRef.current;
    holdPressRef.current = null;
    if (!ownsPress) return;
    // The microphone may already be hearing speech, so an early release waits for the start
    // to settle. Abandoning here would throw that speech away.
    if (startInFlightRef.current) stopAfterStartRef.current = true;
    else if (ownerRef.current === windowMode) void stopRecordingLocal();
  });

  const stopRecording = useEffectEvent(async () => {
    if (ownerRef.current === windowMode || readRecordingOwner() === windowMode) {
      await stopRecordingLocal();
      return;
    }

    dispatchCommandToOwner("stop");
  });

  const pauseRecording = useEffectEvent(async () => {
    if (ownerRef.current === windowMode || readRecordingOwner() === windowMode) {
      await pauseRecordingLocal();
      return;
    }

    dispatchCommandToOwner("pause");
  });

  const resumeRecording = useEffectEvent(async () => {
    if (ownerRef.current === windowMode || readRecordingOwner() === windowMode) {
      await resumeRecordingLocal();
      return;
    }

    dispatchCommandToOwner("resume");
  });

  return {
    livePreview,
    isPreparing,
    isResending,
    mediaStream,
    heldRecording,
    startRecording: () => startRecording(),
    beginHold: () => beginHold(),
    /** Whether the held audio is also kept in history, so dropping it here loses nothing. */
    heldRecordingSaved: () => {
      const payload = heldPayloadRef.current;
      return payload ? spoolKeepsAll(spoolOfPayloadRef.current.get(payload)) : false;
    },
    endHold: () => endHold(),
    pauseRecording: () => pauseRecording(),
    resumeRecording: () => resumeRecording(),
    stopRecording: () => stopRecording(),
    abandonStart: () => abandonStartLocal(),
    cancelRecording: async () => {
      if (ownerRef.current === windowMode || startInFlightRef.current) await cancelRecordingLocal();
      else dispatchCommandToOwner("cancel");
      return heldPayloadRef.current !== null;
    },
    cancelProcessing: () => cancelProcessingLocal(),
    interruptRecording: (message: string) => interruptRecordingLocal(message),
    resendHeldRecording: () => resendHeldRecordingLocal(),
    dropHeldRecording
  };
}
