import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RecordingAudioPayload, TranscriptRecord } from "@shared/types";
import { CANCEL_UNDO_MIN_MS, HELD_RECORDING_TTL_MS, MIN_DICTATION_MS } from "@shared/constants";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import { AudioCaptureController } from "@/lib/audio-capture";
import { playCue } from "@/lib/sounds";
import type { DictationPreview } from "@shared/experimental-dictation";

type RecordingWindowMode = "main" | "overlay";
type RecordingCommand = "pause" | "resume" | "stop" | "cancel";

const RECORDING_OWNER_STORAGE_KEY = "ivrit-recording-owner";
const RECORDING_CONTROL_CHANNEL = "ivrit-recording-control";
const HELD_EXPIRY_CHECK_MS = 30_000;

/** A finished recording that has no transcript yet. It lives only in this window's memory. */
export interface HeldRecording {
  reason: "failed" | "canceled";
  durationMs: number;
}

interface UseRecordingOptions {
  windowMode: RecordingWindowMode;
  timerStartedAt: number | null;
  microphoneDeviceId: string | null;
  permissionStatus: string;
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
  const archiveFailedRef = useRef(false);
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

  const expireHeldRecording = (reason: HeldRecording["reason"] | undefined) => {
    dropHeldRecording();
    if (reason === "failed") onError(he.recordingHeldExpired);
  };

  /** Timers stop while the Mac sleeps, so after a wake only the clock knows how long it has been. */
  const watchHeldExpiry = (payload: RecordingAudioPayload, reason: HeldRecording["reason"]) => {
    const remainingMs = heldExpiryRef.current.get(payload)! - Date.now();
    if (remainingMs <= 0) {
      expireHeldRecording(reason);
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
      if (preview.sessionId === experimentRef.current?.id) setLivePreview(preview);
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
      stopIfCanceled();

      if (permissionStatus !== "granted") {
        await requestPermission();
      }
      if (!mockModeRef.current) {
        const experiment = await window.ivritMenuBar.recording.experimentalBegin?.();
        experimentRef.current = experiment ? { id: experiment.sessionId, sequence: 0, pending: Promise.resolve() } : null;
        controllerRef.current?.setStrictFlush(Boolean(experiment));
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
      if (runtimeStarted) {
        await window.ivritMenuBar.recording.stop().catch(() => undefined);
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
      if (message === he.transcriptionCanceled) {
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
        sampleRate: 16_000,
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
    try {
      const payload = await finishRecording();
      setMediaStream(null);
      releaseOwnership();
      if (!payload || payload.durationMs < MIN_DICTATION_MS) {
        // A brushed shortcut never reaches the engine, which can only guess at so little audio.
        await window.ivritMenuBar.recording.stop();
        if (pressLookedDeliberate()) onError(he.recordingTooShort);
        else if (windowMode === "overlay") await window.ivritMenuBar.overlay?.hide();
        return;
      }

      void playCue("stop").catch(() => undefined);
      // Main's finish path also verifies that the archived PCM equals this
      // complete payload. A failed chunk must not prevent preserving the source.
      await experimentRef.current?.pending.catch(() => undefined);
      await deliverAudio(payload);
    } catch (error) {
      releaseOwnership();
      if (getHebrewErrorMessage(error, he.stopRecordingFailed) === he.transcriptionCanceled) {
        return;
      }

      await window.ivritMenuBar.recording.stop().catch(() => undefined);
      onError(getHebrewErrorMessage(error, he.stopRecordingFailed));
    } finally {
      experimentRef.current = null;
      stopInFlightRef.current = false;
    }
  });

  const cancelRecordingLocal = useEffectEvent(async () => {
    if (stopInFlightRef.current) return;
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
      if (experimentRef.current || keepForUndo) {
        const payload = await finishRecording().catch(() => undefined);
        if (keepForUndo && payload && payload.durationMs >= CANCEL_UNDO_MIN_MS) holdRecording(payload, "canceled");
      } else await controllerRef.current?.destroy();
      await experimentRef.current?.pending.catch(() => undefined);
      await window.ivritMenuBar.recording.stop();
    } finally { experimentRef.current = null; setLivePreview(null); releaseOwnership(); setMediaStream(null); }
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
      if (payload && payload.durationMs >= MIN_DICTATION_MS) holdRecording(payload, "failed");
      await window.ivritMenuBar.recording.stop().catch(() => undefined);
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
      expireHeldRecording(heldRecording?.reason);
      return;
    }
    stopInFlightRef.current = true;
    setHeldRecording(null);
    setIsResending(true);
    try {
      if (windowMode === "overlay") await window.ivritMenuBar.overlay.retarget();
      await window.ivritMenuBar.recording.start(Date.now());
      await deliverAudio(payload);
    } catch (error) {
      if (heldPayloadRef.current === payload) setHeldRecording({ reason: "failed", durationMs: payload.durationMs });
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
    isOwner: ownerRef.current === windowMode,
    startRecording: () => startRecording(),
    beginHold: () => beginHold(),
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
