import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const PHRASES = ["מחר בתשע", "נפגשים לקפה.", "אשלח לך את הכתובת."];
const EXAMPLE = PHRASES.join(" ");
export const SPEECH_BARS = [.18, .32, .54, .38, .7, .92, .58, .8, 1, .66, .42, .76, .56, .34, .48, .24, .16, .3, .52, .74, .6, .36, .22, .44, .68, .5, .28, .14];
// When each phrase is being "said", in ms from the start; the bars talk in these stretches and rest between them.
const SPEECH_SPANS: [number, number][] = [[60, 430], [520, 1120], [1230, 1880]];
const smooth = (edge0: number, edge1: number, value: number) => { const k = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0))); return k * k * (3 - 2 * k); };
const speaking = (ms: number) => Math.max(0, ...SPEECH_SPANS.map(([from, to]) => smooth(from - 70, from + 40, ms) * (1 - smooth(to - 60, to + 120, ms))));
// Each bar gets its own pair of rates and phases, so the voice never pulses in step.
const BAR_MOTION = SPEECH_BARS.map((_, index) => ({ a: 9 + (index * 7.3) % 8, b: 17 + (index * 4.1) % 9, p: index * 1.7, q: index * .9, centre: .55 + .45 * Math.sin(Math.PI * index / (SPEECH_BARS.length - 1)) }));

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An illustration that plays once on entry. It never records, plays audio or transcribes input. */
export function SpeechDemo() {
  const [phase, setPhase] = useState<"idle" | "playing" | "complete">("idle");
  const [motion, setMotion] = useState<"animated" | "instant">("instant");
  const [revealed, setRevealed] = useState(0);
  const [playback, setPlayback] = useState(0);
  const timers = useRef<number[]>([]);
  const waveform = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  const cancelPlayback = useCallback(() => {
    generation.current++;
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  }, []);
  const finishImmediately = useCallback(() => {
    cancelPlayback();
    setMotion("instant");
    setRevealed(PHRASES.length);
    setPhase("complete");
  }, [cancelPlayback]);
  const play = useCallback(() => {
    cancelPlayback();
    setPlayback(value => value + 1);
    if (prefersReducedMotion() || document.hidden) {
      finishImmediately();
      return;
    }
    setMotion("animated");
    setRevealed(0);
    setPhase("playing");
    const current = generation.current;
    const schedule = (delay: number, update: () => void) => {
      timers.current.push(window.setTimeout(() => {
        if (generation.current === current) update();
      }, delay));
    };
    [450, 1150, 1900].forEach((delay, index) => schedule(delay, () => setRevealed(index + 1)));
    schedule(3000, () => { cancelPlayback(); setPhase("complete"); });
  }, [cancelPlayback, finishImmediately]);

  useLayoutEffect(() => { play(); return cancelPlayback; }, [play, cancelPlayback]);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      if (preference.matches && timers.current.length) finishImmediately();
    };
    preference.addEventListener("change", onChange);
    return () => preference.removeEventListener("change", onChange);
  }, [finishImmediately]);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && timers.current.length) finishImmediately();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [finishImmediately]);

  // While playing, the bars follow a speech-like envelope: bursts while a phrase is said, a near-still pause between, each bar on its own rhythm.
  useEffect(() => {
    const bars = waveform.current ? [...waveform.current.children] as HTMLElement[] : [];
    if (phase !== "playing" || motion !== "animated" || !bars.length) return;
    const start = performance.now();
    const current = bars.map(() => .05);
    let raf = 0;
    const step = () => {
      const ms = performance.now() - start, t = ms / 1000, voice = speaking(ms);
      bars.forEach((bar, index) => {
        const m = BAR_MOTION[index]!;
        const wobble = .5 + .3 * Math.sin(t * m.a + m.p) + .2 * Math.sin(t * m.b + m.q);
        const target = .05 + voice * m.centre * (.3 + .7 * wobble) * (.55 + .45 * SPEECH_BARS[index]!);
        // Quick to rise, slower to fall, like a level meter.
        current[index]! += (target - current[index]!) * (target > current[index]! ? .45 : .18);
        bar.style.setProperty("--amp", current[index]!.toFixed(3));
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); bars.forEach(bar => bar.style.removeProperty("--amp")); };
  }, [phase, motion, playback]);

  const playing = phase !== "complete";
  return <section className={`onboarding-demo setup-panel${playing ? " state-recording" : ""}`} data-tone={playing ? undefined : "ok"} aria-label="הדגמה של דיבור לטקסט" data-state={phase} data-motion={motion}>
    <div className="demo-stage">
      <div className="demo-transcript" dir="rtl" aria-hidden="true">
        <p>{PHRASES.map((phrase, index) => <span key={phrase} className="demo-phrase" data-revealed={index < revealed}>{index > 0 ? " " : ""}{phrase}</span>)}</p>
      </div>
      <div ref={waveform} className="demo-waveform" key={playback} aria-hidden="true">
        {SPEECH_BARS.map((level, index) => <span key={index} style={{ "--bar-level": level, "--bar-delay": `${index * 18}ms` } as CSSProperties} />)}
      </div>
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{phase === "complete" ? `משפט לדוגמה: ${EXAMPLE}` : ""}</p>
  </section>;
}
