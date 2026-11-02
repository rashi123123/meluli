// @vitest-environment jsdom
import { act, useImperativeHandle, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecording } from "@/hooks/use-recording";
import { CANCEL_UNDO_MIN_MS, HELD_RECORDING_TTL_MS, MIN_DICTATION_MS } from "@shared/constants";
import { he } from "@shared/locale";

const capture = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), setStrictFlush: vi.fn(), setChunkListener: vi.fn(), getMediaStream: vi.fn(() => null)
}));
vi.mock("@/lib/audio-capture", () => ({ AudioCaptureController: vi.fn(function () { return capture; }) }));
vi.mock("@/lib/sounds", () => ({ playCue: vi.fn(async () => undefined) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Hook = ReturnType<typeof useRecording>;
const payload = (durationMs: number) => ({ pcm: new Float32Array(160), sampleRate: 16_000, durationMs });
let host: HTMLDivElement, root: Root, hook: { current: Hook | null };
let onError: ReturnType<typeof vi.fn>, onTranscript: ReturnType<typeof vi.fn>, recording: Record<string, ReturnType<typeof vi.fn>>;
let overlay: { retarget: ReturnType<typeof vi.fn>; setHeldRecording: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> };
let transcription: { cancel: ReturnType<typeof vi.fn> };
let appBridge: { isMockMode: ReturnType<typeof vi.fn>; onRecordingInterruptRequested: ReturnType<typeof vi.fn> };

function Harness({ mode, handle }: { mode: "main" | "overlay"; handle: Ref<Hook> }) {
  const value = useRecording({
    windowMode: mode, timerStartedAt: null, microphoneDeviceId: null, permissionStatus: "granted",
    requestPermission: async () => undefined, onTranscript: onTranscript as never, onError: onError as never
  });
  useImperativeHandle(handle, () => value);
  return null;
}
const mount = (mode: "main" | "overlay" = "overlay") => act(async () => root.render(<Harness mode={mode} handle={hook as never} />));
const run = (action: (value: Hook) => Promise<unknown>) => act(async () => { await action(hook.current!); });

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of [capture.start, capture.stop, capture.destroy]) mock.mockReset().mockResolvedValue(undefined);
  capture.stop.mockResolvedValue(payload(8_000));
  onError = vi.fn(); onTranscript = vi.fn(); hook = { current: null };
  recording = {
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn().mockResolvedValue({ id: "t", text: "שלום" }), experimentalBegin: vi.fn().mockResolvedValue(null),
    experimentalEnabled: vi.fn().mockResolvedValue(false)
  };
  overlay = { retarget: vi.fn().mockResolvedValue(undefined), setHeldRecording: vi.fn(), hide: vi.fn().mockResolvedValue(true) };
  transcription = { cancel: vi.fn().mockResolvedValue(true) };
  appBridge = { isMockMode: vi.fn().mockResolvedValue(false), onRecordingInterruptRequested: vi.fn(() => () => {}) };
  Object.assign(window, { ivritMenuBar: { app: appBridge, recording, overlay, transcription } });
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} });
  window.localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe("short presses", () => {
  it("never sends a brushed shortcut to the engine", async () => {
    capture.stop.mockResolvedValue(payload(MIN_DICTATION_MS - 1));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(overlay.hide).toHaveBeenCalledOnce();
  });
  it("says so when a deliberate press caught almost nothing", async () => {
    capture.stop.mockResolvedValue(payload(MIN_DICTATION_MS - 1));
    await mount();
    await run(value => value.startRecording());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    await run(value => value.stopRecording());
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(he.recordingTooShort);
    expect(overlay.hide).not.toHaveBeenCalled();
  });
  it("sends anything long enough to be a word", async () => {
    capture.stop.mockResolvedValue(payload(MIN_DICTATION_MS));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    expect(recording.sendAudio).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledOnce();
  });
});

describe("stopping while the microphone is still opening", () => {
  it("cancels instead of being ignored, and leaves nothing running", async () => {
    let open!: () => void;
    capture.start.mockImplementation(() => new Promise<void>(resolve => { open = resolve; }));
    await mount();
    await act(async () => { void hook.current!.startRecording(); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.current!.isPreparing).toBe(true);
    let stopped = false;
    await act(async () => { void hook.current!.stopRecording().then(() => { stopped = true; }); await vi.advanceTimersByTimeAsync(0); open(); await vi.advanceTimersByTimeAsync(0); });
    expect(stopped).toBe(true);
    expect(hook.current!.isPreparing).toBe(false);
    expect(capture.destroy).toHaveBeenCalled();
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it("says nothing was recorded when the press was deliberate", async () => {
    let open!: () => void;
    capture.start.mockImplementation(() => new Promise<void>(resolve => { open = resolve; }));
    await mount();
    await act(async () => { void hook.current!.startRecording(); await vi.advanceTimersByTimeAsync(1_200); });
    let told: boolean | undefined;
    await act(async () => { void hook.current!.abandonStart().then(value => { told = value; }); await vi.advanceTimersByTimeAsync(0); open(); await vi.advanceTimersByTimeAsync(0); });
    expect(told).toBe(true);
    expect(onError).toHaveBeenCalledWith(he.microphoneOpenedTooLate);
    expect(recording.sendAudio).not.toHaveBeenCalled();
  });
});

describe("failed transcription", () => {
  it("keeps the audio and retries it against the current target", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    expect(onError).toHaveBeenCalledWith(he.transcriptionProcessFailed);
    expect(hook.current!.heldRecording).toEqual({ reason: "failed", durationMs: 8_000 });
    const sent = recording.sendAudio.mock.calls[0][0];

    await run(value => value.resendHeldRecording());
    expect(overlay.retarget).toHaveBeenCalledOnce();
    expect(overlay.retarget.mock.invocationCallOrder[0]).toBeLessThan(recording.start.mock.invocationCallOrder[1]);
    expect(recording.sendAudio.mock.calls[1][0]).toBe(sent);
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(hook.current!.heldRecording).toBeNull();
  });
  it("keeps the audio when the retry fails too", async () => {
    recording.sendAudio.mockRejectedValue(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    await run(value => value.resendHeldRecording());
    expect(recording.sendAudio).toHaveBeenCalledTimes(2);
    expect(hook.current!.heldRecording?.reason).toBe("failed");
  });
  it("does not report expiry for audio that is being sent again right now", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error("engine"));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    onError.mockClear();
    let answer = (_: unknown) => {};
    recording.sendAudio.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    await run(async value => {
      const resend = value.resendHeldRecording();
      await vi.waitFor(() => expect(recording.sendAudio).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(HELD_RECORDING_TTL_MS);
      expect(onError).not.toHaveBeenCalled();
      answer({ id: "t", text: "שלום" });
      await resend;
    });
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(hook.current!.heldRecording).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(HELD_RECORDING_TTL_MS); });
    expect(onError).not.toHaveBeenCalled();
  });
  it("still expires audio whose resend could not begin", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error("engine"));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    onError.mockClear();
    overlay.retarget.mockRejectedValueOnce(new Error("no target"));
    await run(value => value.resendHeldRecording());
    expect(hook.current!.heldRecording).toEqual({ reason: "failed", durationMs: 8_000 });
    onError.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(HELD_RECORDING_TTL_MS); });
    expect(hook.current!.heldRecording).toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith(he.recordingHeldExpired);
  });
  it("does not offer to retry silence, which would give the same answer", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionEmptyResult));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    expect(onError).toHaveBeenCalledWith(he.transcriptionEmptyResult);
    expect(hook.current!.heldRecording).toBeNull();
  });
  it("forgets the audio after the retention window", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    await act(async () => { await vi.advanceTimersByTimeAsync(HELD_RECORDING_TTL_MS); });
    expect(hook.current!.heldRecording).toBeNull();
    await run(value => value.resendHeldRecording());
    expect(recording.sendAudio).toHaveBeenCalledOnce();
  });
  const failedRecording = async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    onError.mockClear();
  };
  // The clock keeps going through sleep; timers do not.
  const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);
  it("counts the time the Mac slept, soon after it wakes", async () => {
    await failedRecording();
    sleep(HELD_RECORDING_TTL_MS);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(hook.current!.heldRecording).toBeNull();
    expect(onError).toHaveBeenCalledWith(he.recordingHeldExpired);
    await run(value => value.resendHeldRecording());
    expect(recording.sendAudio).toHaveBeenCalledOnce();
  });
  it("keeps the audio after a short sleep", async () => {
    await failedRecording();
    sleep(HELD_RECORDING_TTL_MS - 60_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(hook.current!.heldRecording?.reason).toBe("failed");
    expect(onError).not.toHaveBeenCalled();
  });
  it("refuses to resend expired audio even if no timer has run yet", async () => {
    await failedRecording();
    sleep(HELD_RECORDING_TTL_MS);
    await run(value => value.resendHeldRecording());
    expect(overlay.retarget).not.toHaveBeenCalled();
    expect(recording.sendAudio).toHaveBeenCalledOnce();
    expect(hook.current!.heldRecording).toBeNull();
    expect(onError).toHaveBeenCalledWith(he.recordingHeldExpired);
  });
  it("gives failed retries no more time than the recording had", async () => {
    await failedRecording();
    await act(async () => { await vi.advanceTimersByTimeAsync(HELD_RECORDING_TTL_MS - 1_000); });
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await run(value => value.resendHeldRecording());
    expect(hook.current!.heldRecording?.reason).toBe("failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(hook.current!.heldRecording).toBeNull();
    expect(onError).toHaveBeenCalledWith(he.recordingHeldExpired);
  });
  it("forgets the audio when a new recording starts", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    await run(value => value.startRecording());
    expect(hook.current!.heldRecording).toBeNull();
  });
});

describe("cancelling", () => {
  it("keeps a long overlay recording for undo and reports that it did", async () => {
    await mount();
    await run(value => value.startRecording());
    let kept = false;
    await run(async value => { kept = await value.cancelRecording(); });
    expect(kept).toBe(true);
    expect(hook.current!.heldRecording).toEqual({ reason: "canceled", durationMs: 8_000 });
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(recording.stop).toHaveBeenCalledOnce();
    await run(value => value.resendHeldRecording());
    expect(recording.sendAudio).toHaveBeenCalledOnce();
  });
  it("honours a cancel that arrives while the stop is still flushing the microphone", async () => {
    await mount();
    await run(value => value.startRecording());
    let flush = (_: unknown) => {};
    capture.stop.mockReturnValueOnce(new Promise(resolve => { flush = resolve; }));
    let kept: boolean | null = null;
    await run(async value => {
      const stopping = value.stopRecording();
      const canceling = value.cancelRecording().then(result => { kept = result; });
      await Promise.resolve();
      flush(payload(8_000));
      await Promise.all([stopping, canceling]);
    });
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(kept).toBe(true);
    expect(hook.current!.heldRecording).toEqual({ reason: "canceled", durationMs: 8_000 });
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
  it("stays quiet when the flush it canceled fails", async () => {
    await mount();
    await run(value => value.startRecording());
    capture.stop.mockReturnValueOnce(new Promise((_, reject) => { window.setTimeout(() => reject(new Error("flush")), 10); }));
    await run(async value => {
      const stopping = value.stopRecording();
      const canceling = value.cancelRecording();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([stopping, canceling]);
    });
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
  it("leaves a cancel after the audio was sent to the processing path", async () => {
    await mount();
    await run(value => value.startRecording());
    let answer = (_: unknown) => {};
    recording.sendAudio.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    await run(async value => {
      const stopping = value.stopRecording();
      await vi.waitFor(() => expect(recording.sendAudio).toHaveBeenCalledOnce());
      await value.cancelRecording();
      answer({ id: "t", text: "שלום" });
      await stopping;
    });
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(recording.stop).not.toHaveBeenCalled();
  });
  it("forgets an earlier flush cancel on the next stop", async () => {
    await mount();
    await run(value => value.startRecording());
    await run(async value => {
      const stopping = value.stopRecording();
      await value.cancelRecording();
      await stopping;
    });
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    expect(recording.sendAudio).toHaveBeenCalledOnce();
  });
  it("lets a short recording go, since there is little to lose", async () => {
    capture.stop.mockResolvedValue(payload(CANCEL_UNDO_MIN_MS - 1));
    await mount();
    await run(value => value.startRecording());
    let kept = true;
    await run(async value => { kept = await value.cancelRecording(); });
    expect(kept).toBe(false);
    expect(hook.current!.heldRecording).toBeNull();
  });
  it("discards at once from the main window, which has no undo", async () => {
    await mount("main");
    await run(value => value.startRecording());
    await run(value => value.cancelRecording());
    expect(capture.stop).not.toHaveBeenCalled();
    expect(capture.destroy).toHaveBeenCalled();
    expect(hook.current!.heldRecording).toBeNull();
  });
});

describe("speech at the very start", () => {
  it("opens the microphone without waiting for main to finish taking the target", async () => {
    let release = () => {};
    recording.start.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await mount();
    await act(async () => { void hook.current!.startRecording(); await vi.advanceTimersByTimeAsync(0); });
    expect(capture.start).toHaveBeenCalled();
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
  });
  it("keeps the research order, where the archive session exists before any sample", async () => {
    recording.experimentalEnabled.mockResolvedValue(true);
    recording.experimentalBegin.mockResolvedValue({ sessionId: "s" });
    await mount();
    await run(value => value.startRecording());
    expect(recording.experimentalBegin.mock.invocationCallOrder[0]).toBeLessThan(capture.start.mock.invocationCallOrder[0]);
  });
});

describe("audio that must survive", () => {
  const whileProcessing = async () => {
    let reject = (_: Error) => {};
    recording.sendAudio.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    await mount();
    await run(value => value.startRecording());
    await act(async () => { void hook.current!.stopRecording(); await vi.advanceTimersByTimeAsync(0); });
    return (error: Error) => reject(error);
  };
  it("holds the audio when processing is canceled, however short it was", async () => {
    capture.stop.mockResolvedValue(payload(MIN_DICTATION_MS + 10));
    const fail = await whileProcessing();
    let result: { canceled: boolean; held: boolean } | undefined;
    await act(async () => {
      const canceling = hook.current!.cancelProcessing().then(value => { result = value; });
      fail(new Error(he.transcriptionCanceled));
      await canceling;
    });
    expect(result).toEqual({ canceled: true, held: true });
    expect(hook.current!.heldRecording?.reason).toBe("canceled");
    expect(overlay.setHeldRecording).toHaveBeenLastCalledWith("canceled");
    expect(onError).not.toHaveBeenCalled();
  });
  it("sends the same audio exactly once on Undo after canceling processing", async () => {
    const fail = await whileProcessing();
    await act(async () => { const canceling = hook.current!.cancelProcessing(); fail(new Error(he.transcriptionCanceled)); await canceling; });
    const sent = recording.sendAudio.mock.calls[0][0];
    await run(value => value.resendHeldRecording());
    expect(recording.sendAudio).toHaveBeenCalledTimes(2);
    expect(recording.sendAudio.mock.calls[1][0]).toBe(sent);
    await run(value => value.resendHeldRecording());
    expect(recording.sendAudio).toHaveBeenCalledTimes(2);
  });
  it("keeps a recording the computer cut off, and pastes nothing", async () => {
    await mount();
    await run(value => value.startRecording());
    await run(value => value.interruptRecording(he.recordingInterrupted));
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(recording.stop).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(he.recordingInterrupted);
    expect(hook.current!.heldRecording).toEqual({ reason: "failed", durationMs: 8_000 });
  });
  it("stops a main-window recording when the computer cuts it off", async () => {
    await mount("main");
    await run(value => value.startRecording());
    const interrupt = appBridge.onRecordingInterruptRequested.mock.calls[0]![0] as () => void;
    await act(async () => { interrupt(); await vi.advanceTimersByTimeAsync(0); });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(recording.stop).toHaveBeenCalled();
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(he.recordingInterrupted);
    expect(hook.current!.heldRecording).toEqual({ reason: "failed", durationMs: 8_000 });
  });
  it("leaves the interrupt to the HUD in the floating window", async () => {
    await mount("overlay");
    expect(appBridge.onRecordingInterruptRequested).not.toHaveBeenCalled();
  });
  it("reports a lost microphone through the same path", async () => {
    const { AudioCaptureController } = await import("@/lib/audio-capture");
    await mount();
    await run(value => value.startRecording());
    const onEnded = vi.mocked(AudioCaptureController).mock.calls.at(-1)![0]!;
    await act(async () => { onEnded(); await vi.advanceTimersByTimeAsync(0); });
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(he.microphoneDisconnected);
    expect(hook.current!.heldRecording?.reason).toBe("failed");
  });
  it("says when failed audio it was holding is gone", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    onError.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(HELD_RECORDING_TTL_MS); });
    expect(onError).toHaveBeenCalledWith(he.recordingHeldExpired);
  });
  it("masks a retry as processing, not a live recording", async () => {
    recording.sendAudio.mockRejectedValueOnce(new Error(he.transcriptionProcessFailed));
    await mount();
    await run(value => value.startRecording());
    await run(value => value.stopRecording());
    let finish = (_: unknown) => {};
    recording.sendAudio.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { void hook.current!.resendHeldRecording(); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.current!.isResending).toBe(true);
    await act(async () => { finish({ id: "t", text: "שלום" }); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.current!.isResending).toBe(false);
  });
});

describe("holding the key", () => {
  it("records from press to release and delivers the speech", async () => {
    await mount();
    await act(async () => { hook.current!.beginHold(); });
    expect(capture.start).toHaveBeenCalled();
    await act(async () => { hook.current!.endHold(); });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(recording.sendAudio).toHaveBeenCalledOnce();
  });
  it("keeps speech when the key comes back while the microphone is still opening", async () => {
    let opened = () => {};
    capture.start.mockImplementation(() => new Promise<void>(resolve => { opened = resolve; }));
    await mount();
    await act(async () => { hook.current!.beginHold(); });
    await act(async () => { hook.current!.endHold(); });
    expect(capture.destroy).not.toHaveBeenCalled();
    expect(recording.sendAudio).not.toHaveBeenCalled();
    await act(async () => { opened(); });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(recording.sendAudio).toHaveBeenCalledOnce();
  });
  it("leaves alone a recording the shortcut began, which only the shortcut may end", async () => {
    await mount();
    await run(value => value.startRecording());
    await act(async () => { hook.current!.endHold(); });
    expect(capture.stop).not.toHaveBeenCalled();
  });
  it("does not take over a recording already under way", async () => {
    await mount();
    await run(value => value.startRecording());
    expect(hook.current!.beginHold()).toBe(false);
    await act(async () => { hook.current!.endHold(); });
    expect(capture.stop).not.toHaveBeenCalled();
  });
  it("drops a brushed key like a brushed shortcut", async () => {
    capture.stop.mockResolvedValue(payload(MIN_DICTATION_MS - 1));
    await mount();
    await act(async () => { hook.current!.beginHold(); });
    await act(async () => { hook.current!.endHold(); });
    expect(recording.sendAudio).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(overlay.hide).toHaveBeenCalledOnce();
  });
});
