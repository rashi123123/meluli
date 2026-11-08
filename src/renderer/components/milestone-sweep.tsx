import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { accentChain, createShader, cubicBezier, playSweep } from "glimm";
import { GlimmScope, type GlimmScopeHandle } from "glimm/react";

// glimm sweeps for rare moments only. Finishing setup sweeps the window; a setup step that works sweeps just its own panel. Not for results, navigation or dictation: a full-screen sweep on every finish makes the app feel slow.
type Play = (from: Element | null, change: () => void | Promise<unknown>) => void;

const MilestoneSweepContext = createContext<Play>((_, change) => void change());

export const useMilestoneSweep = () => useContext(MilestoneSweepContext);

// Mostly the logo's own indigo, from the tongue through the stand to the capsule (resources/icons/Meluli.icon), with a violet touch only at the end.
const LOGO_PALETTE = accentChain(["#3B4ADB", "#5A6BFF", "#7D8EFF", "#A27BF5"]);

export function MilestoneScope({ children }: { children: ReactNode }) {
  const scope = useRef<GlimmScopeHandle>(null);
  const box = useRef<HTMLDivElement>(null);

  const play: Play = (from, change) => {
    const target = from?.getBoundingClientRect();
    const frame = box.current?.getBoundingClientRect();
    scope.current?.play({
      // Centred across the window, so the rounded band trails evenly at both ends instead of kinking on one side
      at: target && frame ? [frame.width / 2, target.top + target.height / 2 - frame.top] : undefined,
      change
    });
  };

  return <MilestoneSweepContext.Provider value={play}>
    <div ref={box} style={{ position: "absolute", inset: 0 }}>
      {/* Colour, direction and a gentle arc are ours; timing, band and page motion stay at glimm's own defaults. */}
      <GlimmScope ref={scope} palette={LOGO_PALETTE} direction="btt" curve={0.12}
        style={{ position: "absolute", inset: 0 }}>
        {children}
      </GlimmScope>
    </div>
  </MilestoneSweepContext.Provider>;
}

// Eased: it holds a beat at the bottom, runs through the middle and settles softly at the top.
const PANEL_EASE = cubicBezier(0.65, 0, 0.25, 1);
const PANEL_SWEEP_MS = 1150;
// What the band touches on its way up: each gets --lit (0 → 1 once the band has passed it) and --hit (1 while the band is on it).
const SWEEP_TARGETS = ".demo-transcript p, .demo-status, .microphone-feedback, .setup-status";
// Voice bars each ride a small spring: the band's arc reaches the middle bars first, they jump, overshoot below rest as it leaves, and settle.
const SWEEP_BARS = ".demo-waveform > span, .microphone-level > span";
const BAND_CURVE = 0.14;
// Where the band's bright edge is, from the shader's progress, as a share of the panel's height from the bottom. Tuned against recordings so the text lights with the edge, not after it.
const BAND_SCALE = 1.0, BAND_LEAD = 0.1;
const HIT_REACH = 0.22;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Sweeps the logo colours through one setup panel, only inside it, the moment its step works (the demo lands, the mic hears you, the key is felt, the engine is ready). Text waits in grey and turns white as the band passes it; the voice bars jump as it crosses them. */
type Shader = NonNullable<ReturnType<typeof createShader>>;
const makePanelShader = (canvas: HTMLCanvasElement): Shader | null => createShader({ canvas, palette: LOGO_PALETTE, bandTight: 22, direction: "btt", curve: 0.14, swellAmount: 0.55, brightness: 1.15, waveAmount: 0.9, rippleAmount: 1.2, waveSpeed: 1.4 });

export function PanelSweep({ done, children }: { done: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const shader = useRef<Shader | null>(null);
  const wasDone = useRef(done);
  // While the step waits, get the shader compiled with one invisible frame, so the sweep's first frames don't stall on it.
  // At rest it draws nothing (glimm stops its loop at zero alpha); it is let go once its sweep ends.
  useEffect(() => {
    if (done || shader.current || !canvas.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const warm = makePanelShader(canvas.current);
    if (!warm) return;
    shader.current = warm;
    warm.setProgress(0);
    warm.setAlpha(0.001);
    const settle = requestAnimationFrame(() => requestAnimationFrame(() => warm.setAlpha(0)));
    return () => { cancelAnimationFrame(settle); };
  }, [done]);
  useEffect(() => () => { shader.current?.destroy(); shader.current = null; }, []);
  // Layout effect, so the text is already grey on the first frame of the sweep instead of flashing white.
  useLayoutEffect(() => {
    const starts = done && !wasDone.current;
    wasDone.current = done;
    if (!starts || !box.current || !canvas.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const gl = shader.current ?? makePanelShader(canvas.current);
    shader.current = null;
    if (!gl) return;
    const frame = box.current.getBoundingClientRect();
    const targets = [...box.current.querySelectorAll<HTMLElement>(SWEEP_TARGETS)].map(el => {
      const rect = el.getBoundingClientRect();
      return { el, from: (frame.bottom - rect.bottom) / frame.height, to: (frame.bottom - rect.top) / frame.height };
    });
    const paint = (band: number) => {
      for (const { el, from, to } of targets) {
        el.style.setProperty("--lit", clamp01((band - from) / Math.max(0.01, to - from)).toFixed(3));
        el.style.setProperty("--hit", clamp01(1 - Math.abs(band - (from + to) / 2) / HIT_REACH).toFixed(3));
      }
    };
    const bars = [...box.current.querySelectorAll<HTMLElement>(SWEEP_BARS)].map(el => {
      const rect = el.parentElement!.getBoundingClientRect(), own = el.getBoundingClientRect();
      const across = Math.abs((own.left + own.width / 2 - frame.left) / frame.width - .5) * 2;
      return { el, mid: (frame.bottom - (rect.top + rect.height / 2)) / frame.height, lag: BAND_CURVE * across * across, pop: 0, speed: 0 };
    });
    const springBars = (band: number) => {
      let moving = false;
      for (const bar of bars) {
        const reach = clamp01(1 - Math.abs(band - bar.lag - bar.mid) / HIT_REACH);
        bar.speed = bar.speed * .8 + (reach * reach * (3 - 2 * reach) - bar.pop) * .2;
        bar.pop += bar.speed;
        if (Math.abs(bar.pop) > .004 || Math.abs(bar.speed) > .004) moving = true;
        bar.el.style.setProperty("--pop", bar.pop.toFixed(3));
      }
      return moving;
    };
    paint(-1);
    // The band only climbs; the shader resets its progress after the outro, which must not turn the text grey again.
    let band = -1, raf = 0, swept = false;
    const track = () => {
      band = swept ? 2 : Math.max(band, gl.getProgress() * BAND_SCALE + BAND_LEAD);
      paint(band);
      // The springs keep going after the band has left until every bar has settled.
      if (springBars(band) || !swept) raf = requestAnimationFrame(track);
      else release();
    };
    raf = requestAnimationFrame(track);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      cancelAnimationFrame(raf);
      for (const { el } of targets) { el.style.removeProperty("--lit"); el.style.removeProperty("--hit"); }
      for (const { el } of bars) el.style.removeProperty("--pop");
      gl.destroy();
    };
    const sweep = playSweep(gl, { sweepMs: PANEL_SWEEP_MS, outroMs: 260, easing: PANEL_EASE, onComplete: () => { swept = true; } });
    return () => { sweep.cancel(); release(); };
  }, [done]);
  return <div ref={box} className="panel-sweep">
    {children}
    <canvas ref={canvas} className="panel-sweep-canvas" aria-hidden="true" />
  </div>;
}
