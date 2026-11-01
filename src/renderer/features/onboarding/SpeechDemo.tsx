import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { ArrowClockwise } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { he } from "@shared/locale";

const PHRASES = ["מחר בתשע", "נפגשים לקפה.", "אשלח לך את הכתובת."];
const EXAMPLE = PHRASES.join(" ");
export const SPEECH_BARS = [.18, .32, .54, .38, .7, .92, .58, .8, 1, .66, .42, .76, .56, .34, .48, .24, .16, .3, .52, .74, .6, .36, .22, .44, .68, .5, .28, .14];
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An illustration that plays once on entry. It never records, plays audio or transcribes input. */
export function SpeechDemo() {
  const [phase, setPhase] = useState<"idle" | "playing" | "complete">("idle");
  const [motion, setMotion] = useState<"animated" | "instant">("instant");
  const [revealed, setRevealed] = useState(0);
  const [playback, setPlayback] = useState(0);
  const timers = useRef<number[]>([]);
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

  // Native keyboard and assistive-technology activation has no click count.
  const replay = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) {
      setPlayback(value => value + 1);
      finishImmediately();
    } else play();
  };

  const playing = phase !== "complete";
  return <section className={`onboarding-demo setup-panel${playing ? " state-recording" : ""}`} data-tone={playing ? undefined : "ok"} aria-label="הדגמה של דיבור לטקסט" data-state={phase} data-motion={motion}>
    <div className="demo-stage">
      <p className="demo-status" aria-hidden="true"><span className="led" />{playing ? he.recording : he.idle}</p>
      <div className="demo-transcript" dir="rtl" aria-hidden="true">
        <p>{PHRASES.map((phrase, index) => <span key={phrase} className="demo-phrase" data-revealed={index < revealed}>{index > 0 ? " " : ""}{phrase}</span>)}</p>
      </div>
      <div className="demo-waveform" key={playback} aria-hidden="true">
        {SPEECH_BARS.map((level, index) => <span key={index} style={{ "--bar-level": level, "--bar-delay": `${index * 18}ms` } as CSSProperties} />)}
      </div>
    </div>
    <div className="demo-transport">
      <span>משפט לדוגמה · ללא הקלטה</span>
      <Button variant="ghost" size="sm" onClick={replay}><ArrowClockwise />הפעלה חוזרת</Button>
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{phase === "complete" ? `משפט לדוגמה: ${EXAMPLE}` : ""}</p>
  </section>;
}
