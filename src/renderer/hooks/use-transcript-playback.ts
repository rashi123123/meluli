import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

export type PlaybackStatus = "none" | "loading" | "ready" | "missing";

const RATES = [1, 1.25, 1.5] as const;

/** Plays the kept recording behind a transcript. Audio stays on this Mac: main hands over the bytes, the page plays a blob. */
export function useTranscriptPlayback(recordingId: string | null | undefined) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>(recordingId ? "loading" : "none");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<number>(1);

  useEffect(() => {
    if (!recordingId) { setStatus("none"); return; }
    let live = true;
    let objectUrl: string | null = null;
    // A removed <audio> pauses itself; one that stays for another recording is paused here.
    const element = audio.current;
    setStatus("loading");
    const api = window.ivritMenuBar.recordings;
    (api ? api.audio(recordingId) : Promise.resolve(null)).then((bytes) => {
      if (!live) return;
      if (!bytes) { setStatus("missing"); return; }
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/wav" }));
      setUrl(objectUrl);
      setStatus("ready");
    }, () => { if (live) setStatus("missing"); });
    return () => {
      live = false;
      element?.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
      setPlaying(false);
      setTime(0);
    };
  }, [recordingId]);

  const play = useCallback(() => { void audio.current?.play().catch(() => setPlaying(false)); }, []);
  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) play(); else element.pause();
  }, [play]);
  const playFrom = useCallback((seconds: number) => {
    const element = audio.current;
    if (!element) return;
    element.currentTime = Math.max(0, seconds);
    setTime(element.currentTime);
    play();
  }, [play]);
  /** Moves the playhead without starting playback, as dragging the bar does. */
  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (!element) return;
    element.currentTime = Math.max(0, seconds);
    setTime(element.currentTime);
  }, []);
  const cycleRate = useCallback(() => {
    setRate((current) => {
      const next = RATES[(RATES.indexOf(current as typeof RATES[number]) + 1) % RATES.length];
      if (audio.current) audio.current.playbackRate = next;
      return next;
    });
  }, []);

  /** Props for the one <audio> element. Kept outside the read/edit switch so editing does not stop it. */
  const audioProps = {
    ref: audio,
    src: url ?? undefined,
    preload: "metadata" as const,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => { setPlaying(false); setTime(0); },
    onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => { if (!event.currentTarget.ended) setTime(event.currentTarget.currentTime); },
    onLoadedMetadata: (event: SyntheticEvent<HTMLAudioElement>) => {
      const value = event.currentTarget.duration;
      setDuration(Number.isFinite(value) ? value : 0);
      event.currentTarget.playbackRate = rate;
    }
  };

  return { status, playing, time, duration, rate, toggle, playFrom, seek, cycleRate, audioProps };
}

export type TranscriptPlayback = ReturnType<typeof useTranscriptPlayback>;
