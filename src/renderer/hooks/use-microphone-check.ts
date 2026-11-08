import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getHebrewErrorMessage } from "@shared/error-utils";
import type { MicrophonePermissionStatus } from "@shared/types";

export type MicrophoneCheckStatus = "idle" | "requesting" | "listening" | "detected" | "error";

interface MicrophoneCheckOptions {
  enabled: boolean;
  deviceId?: string;
  onRequestPermission: () => Promise<MicrophonePermissionStatus>;
}

interface CheckState {
  status: MicrophoneCheckStatus;
  level: number;
  error: string | null;
  hasDetected: boolean;
}

interface CheckSession {
  released: boolean;
  stream: MediaStream | null;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  frame: number | null;
  endedListeners: Array<{ track: MediaStreamTrack; listener: () => void }>;
}

const initialState: CheckState = { status: "idle", level: 0, error: null, hasDetected: false };
const permissionError = "אין הרשאה למיקרופון. אפשר לאפשר גישה בהגדרות המערכת ולנסות שוב.";
const unavailableError = "לא מצאנו את המיקרופון שנבחר. אפשר לחבר אותו ולנסות שוב.";
const disconnectedError = "המיקרופון נותק. אפשר לחבר אותו ולנסות שוב.";
const minimumSignalRms = 0.012;
const sustainedSignalMs = 240;
const sampleIntervalMs = 32;
/** A gap between frames longer than this restarts the sustained-signal count. */
const maxFrameGapMs = 120;

function microphoneError(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return permissionError;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return unavailableError;
  if (name === "NotReadableError" || name === "TrackStartError") return "לא הצלחנו לפתוח את המיקרופון. ייתכן שאפליקציה אחרת משתמשת בו.";
  return getHebrewErrorMessage(error, "בדיקת המיקרופון לא התחילה. אפשר לנסות שוב.");
}

// The graph measures live input only. It is never connected to speakers, stored,
// sent to IPC, or passed to the recording/transcription pipeline.
export function useMicrophoneCheck({ enabled, deviceId, onRequestPermission }: MicrophoneCheckOptions) {
  const [state, setState] = useState<CheckState>(initialState);
  const mounted = useRef(false);
  const sessionRef = useRef<CheckSession | null>(null);

  const release = useCallback((session: CheckSession) => {
    if (session.released) return;
    session.released = true;
    if (sessionRef.current === session) sessionRef.current = null;
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    session.endedListeners.forEach(({ track, listener }) => track.removeEventListener("ended", listener));
    session.stream?.getTracks().forEach(track => track.stop());
    try { session.source?.disconnect(); } catch { /* The graph may already be disconnected. */ }
    try { session.analyser?.disconnect(); } catch { /* The graph may already be disconnected. */ }
    if (session.context && session.context.state !== "closed") {
      void session.context.close().catch(() => undefined);
    }
  }, []);

  const stop = useCallback(() => {
    if (sessionRef.current) release(sessionRef.current);
    if (mounted.current) setState(current => current.status === "idle" && !current.hasDetected ? current : initialState);
  }, [release]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (sessionRef.current) release(sessionRef.current);
    };
  }, [release]);

  // Changing devices or yielding to the recorder invalidates pending permission
  // and getUserMedia results before they can acquire a new audio graph.
  useLayoutEffect(() => {
    if (!enabled) stop();
    return stop;
  }, [enabled, deviceId, stop]);

  useEffect(() => {
    const onVisibilityChange = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [stop]);

  const start = useCallback(async () => {
    if (!mounted.current || !enabled || document.hidden || sessionRef.current) return;
    const session: CheckSession = { released: false, stream: null, context: null, source: null, analyser: null, frame: null, endedListeners: [] };
    sessionRef.current = session;
    const isCurrent = () => mounted.current && !session.released && sessionRef.current === session && !document.hidden;
    const fail = (message: string) => {
      if (!isCurrent()) return;
      release(session);
      setState({ status: "error", level: 0, error: message, hasDetected: false });
    };
    setState({ status: "requesting", level: 0, error: null, hasDetected: false });

    try {
      const permission = await onRequestPermission();
      if (!isCurrent()) return;
      if (permission !== "granted") {
        fail(permission === "restricted" ? "הגישה למיקרופון מוגבלת בהגדרות המערכת." : permissionError);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
        fail("בדיקת המיקרופון לא זמינה כרגע. אפשר לנסות שוב.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
      });
      if (!isCurrent()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      session.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.every(track => track.readyState === "ended")) {
        fail(unavailableError);
        return;
      }
      tracks.forEach(track => {
        const listener = () => fail(disconnectedError);
        track.addEventListener("ended", listener);
        session.endedListeners.push({ track, listener });
      });
      const context = new window.AudioContext();
      session.context = context;
      const analyser = context.createAnalyser();
      session.analyser = analyser;
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      session.source = context.createMediaStreamSource(stream);
      session.source.connect(analyser);
      if (context.state === "suspended") await context.resume();
      if (!isCurrent()) return;
      if (context.state !== "running") {
        fail("בדיקת המיקרופון לא התחילה. אפשר לנסות שוב.");
        return;
      }
      const samples = new Float32Array(analyser.fftSize);
      let signalSince: number | null = null;
      let lastSampleAt: number | null = null;
      let detected = false;
      setState({ status: "listening", level: 0, error: null, hasDetected: false });

      const sample = (now: number) => {
        if (!isCurrent()) return;
        if (lastSampleAt === null || now - lastSampleAt >= sampleIntervalMs) {
          // A delayed frame cannot count the unobserved interval as input.
          if (lastSampleAt !== null && now - lastSampleAt > maxFrameGapMs) signalSince = null;
          lastSampleAt = now;
          try {
            analyser.getFloatTimeDomainData(samples);
            const sum = samples.reduce((total, value) => total + value * value, 0);
            const rms = tracks.every(track => track.muted) ? 0 : Math.sqrt(sum / samples.length);
            if (rms >= minimumSignalRms) {
              signalSince ??= now;
              if (now - signalSince >= sustainedSignalMs) detected = true;
            } else signalSince = null;
            // Display gain keeps ordinary speech legible without inventing input.
            const level = Math.round(Math.min(1, rms * 8) * 100) / 100;
            setState(current => current.level === level && current.hasDetected === detected
              ? current
              : { status: detected ? "detected" : "listening", level, error: null, hasDetected: detected });
          } catch {
            fail("לא הצלחנו לקרוא את עוצמת המיקרופון. אפשר לנסות שוב.");
            return;
          }
        }
        session.frame = requestAnimationFrame(sample);
      };
      session.frame = requestAnimationFrame(sample);
    } catch (error) {
      fail(microphoneError(error));
    }
  }, [deviceId, enabled, onRequestPermission, release]);

  return { ...state, start, stop };
}
