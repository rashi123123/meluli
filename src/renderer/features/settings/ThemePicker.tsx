import { THEME_IDS, THEMES, type ThemeId, type ThemeSwatch } from "@shared/themes";
import { useId, type CSSProperties } from "react";

function SwatchLayer({ swatch, half = false }: { swatch: ThemeSwatch; half?: boolean }) {
  const style = { "--swatch-page": swatch.page, "--swatch-raised": swatch.raised, "--swatch-ink": swatch.ink, "--swatch-accent": swatch.accent } as CSSProperties;
  return <span className="theme-swatch-layer" data-half={half || undefined} style={style}>
    <span className="theme-swatch-rail"><span /><span /><span /></span>
    <span className="theme-swatch-card">
      <span className="theme-swatch-text" />
      <span className="theme-swatch-text" />
      <span className="theme-swatch-capsule"><span /><span /><span /><span /><span /></span>
    </span>
  </span>;
}

export function ThemePicker({ value, labelledBy, onChange }: { value: ThemeId; labelledBy: string; onChange: (theme: ThemeId) => void }) {
  const name = useId();
  return <div className="theme-picker" role="radiogroup" aria-labelledby={labelledBy}>
    {THEME_IDS.map((id) => <label key={id} className="theme-option">
      <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} />
      <span className="theme-swatch" aria-hidden="true">
        <SwatchLayer swatch={THEMES[id].swatch} />
        {id === "system" && <SwatchLayer swatch={THEMES["meluli-light"].swatch} half />}
      </span>
      <span className="theme-name">{THEMES[id].label}</span>
    </label>)}
  </div>;
}
