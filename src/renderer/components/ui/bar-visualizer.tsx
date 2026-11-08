import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface AudioAnalyserOptions {
  fftSize?: number;
  smoothingTimeConstant?: number;
  minDecibels?: number;
  maxDecibels?: number;
}

function createAudioAnalyser(mediaStream: MediaStream, options: AudioAnalyserOptions = {}) {
  const audioContext = new (window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
  const source = audioContext.createMediaStreamSource(mediaStream);
  const analyser = audioContext.createAnalyser();

  if (options.fftSize) analyser.fftSize = options.fftSize;
  if (options.smoothingTimeConstant !== undefined) {
    analyser.smoothingTimeConstant = options.smoothingTimeConstant;
  }
  if (options.minDecibels !== undefined) analyser.minDecibels = options.minDecibels;
  if (options.maxDecibels !== undefined) analyser.maxDecibels = options.maxDecibels;

  source.connect(analyser);
  void audioContext.resume().catch(() => undefined);

  const cleanup = () => {
    source.disconnect();
    void audioContext.close().catch(() => undefined);
  };

  return { analyser, cleanup };
}

export interface MultiBandVolumeOptions {
  bands?: number;
  loPass?: number;
  hiPass?: number;
  updateInterval?: number;
  analyserOptions?: AudioAnalyserOptions;
}

const multibandDefaults: MultiBandVolumeOptions = {
  bands: 5,
  loPass: 100,
  hiPass: 600,
  updateInterval: 32,
  analyserOptions: { fftSize: 2048 }
};

// Calibrated so a quiet room stays flat and ordinary speech reaches most of the range.
const normalizeDb = (value: number) => {
  if (value === -Infinity) return 0;
  const minDb = -85;
  const maxDb = -30;
  return (Math.max(minDb, Math.min(maxDb, value)) - minDb) / (maxDb - minDb);
};

export function useDocumentVisible() {
  const [isVisible, setIsVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible"
  );

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      setIsVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return isVisible;
}

export function useMultibandVolume(
  mediaStream?: MediaStream | null,
  options: MultiBandVolumeOptions = {},
  isActive = true
) {
  const opts = useMemo(
    () => ({ ...multibandDefaults, ...options }),
    [
      options.bands,
      options.loPass,
      options.hiPass,
      options.updateInterval,
      options.analyserOptions?.fftSize,
      options.analyserOptions?.smoothingTimeConstant,
      options.analyserOptions?.minDecibels,
      options.analyserOptions?.maxDecibels
    ]
  );

  const [frequencyBands, setFrequencyBands] = useState<number[]>(() => new Array(opts.bands).fill(0));
  const bandsRef = useRef<number[]>(new Array(opts.bands).fill(0));
  const intervalId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!mediaStream || !isActive) {
      const emptyBands = new Array(opts.bands).fill(0);
      setFrequencyBands(emptyBands);
      bandsRef.current = emptyBands;
      return;
    }

    const { analyser, cleanup } = createAudioAnalyser(mediaStream, opts.analyserOptions);
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    const sliceStart = opts.loPass!;
    const sliceEnd = opts.hiPass!;
    const sliceLength = sliceEnd - sliceStart;

    const updateInterval = opts.updateInterval!;

    const updateVolume = () => {
      analyser.getFloatFrequencyData(dataArray);
      const chunks = new Array(opts.bands!);

      for (let bandIndex = 0; bandIndex < opts.bands!; bandIndex += 1) {
        let sum = 0;
        let count = 0;
        const startIndex = sliceStart + Math.floor(bandIndex * sliceLength / opts.bands!);
        const endIndex = Math.max(startIndex + 1, sliceStart + Math.floor((bandIndex + 1) * sliceLength / opts.bands!));

        for (let dataIndex = startIndex; dataIndex < endIndex; dataIndex += 1) {
          sum += normalizeDb(dataArray[dataIndex]!);
          count += 1;
        }

        chunks[bandIndex] = count > 0 ? sum / count : 0;
      }

      let hasChanged = false;
      for (let index = 0; index < chunks.length; index += 1) {
        if (Math.abs(chunks[index]! - bandsRef.current[index]!) > 0.01) {
          hasChanged = true;
          break;
        }
      }

      if (hasChanged) {
        bandsRef.current = chunks;
        setFrequencyBands(chunks);
      }
    };

    updateVolume();
    intervalId.current = window.setInterval(updateVolume, updateInterval);

    return () => {
      cleanup();
      if (intervalId.current !== undefined) {
        window.clearInterval(intervalId.current);
      }
    };
  }, [isActive, mediaStream, opts]);

  return frequencyBands;
}

export type AgentState =
  | "idle"
  | "connecting"
  | "initializing"
  | "analyzing"
  | "downloading"
  | "listening"
  | "speaking"
  | "thinking";

export interface BarVisualizerProps extends React.HTMLAttributes<HTMLDivElement> {
  state?: AgentState;
  barCount?: number;
  mediaStream?: MediaStream | null;
  minHeight?: number;
  maxHeight?: number;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const prefersReducedMotion = () => window.matchMedia(reducedMotionQuery).matches;
const watchReducedMotion = (onChange: () => void) => {
  const preference = window.matchMedia(reducedMotionQuery);
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
};

// Real audio feedback uses transform; idle, paused and reduced-motion states stay still.
// Voice energy sits in the low bands, so they take the centre and fall off to both sides.
export const BarVisualizer = React.memo(React.forwardRef<HTMLDivElement, BarVisualizerProps>(
  function BarVisualizer({ state = "idle", barCount = 15, mediaStream, minHeight = 18, maxHeight = 92, className, style, ...props }, ref) {
    const reduced = React.useSyncExternalStore(watchReducedMotion, prefersReducedMotion);
    const visible = useDocumentVisible();
    const active = visible && !reduced && state === "speaking";
    const bandCount = Math.ceil(barCount / 2);
    const bands = useMultibandVolume(mediaStream, { bands: bandCount, loPass: 4, hiPass: 90 }, active);
    return <div ref={ref} data-state={state} className={cn("audio-meter", className)} style={style} {...props}>
      {Array.from({ length: barCount }, (_, index) => {
        const band = Math.min(bandCount - 1, Math.floor(Math.abs(index - (barCount - 1) / 2)));
        const level = active && mediaStream ? (bands[band] ?? 0) * 100 : minHeight;
        const scale = Math.min(maxHeight, Math.max(minHeight, level)) / 100;
        return <span key={index} style={{ transform: `scaleY(${scale})`, "--bar": index } as React.CSSProperties} />;
      })}
    </div>;
  }
));
