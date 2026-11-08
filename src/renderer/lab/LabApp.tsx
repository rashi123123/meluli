import { useEffect, useMemo, useRef, useState } from "react";
import { THEMES, THEME_IDS, type ThemeId } from "@shared/themes";
import { applyTheme } from "@/lib/theme";
import { usePointerFeedback } from "@/components/usePointerFeedback";
import { stories } from "./stories";
import { onLabCall, type LabCall } from "./mock-bridge";
import { setLabScheme, type LabScheme } from "./scheme";

interface Note { id: string; story: string; state: string; target: string; text: string; at: number }

const STORAGE = { story: "meluli-lab:story", theme: "meluli-lab:theme", scheme: "meluli-lab:scheme", width: "meluli-lab:width", notes: "meluli-lab:notes" };
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private window */ } };
const WIDTHS = { narrow: "צר · 420", window: "חלון · 760", wide: "רחב · 1100" } as const;
type Width = keyof typeof WIDTHS;

function readNotes(): Note[] {
  try { const parsed = JSON.parse(read(STORAGE.notes) ?? "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** A short, readable path from the state frame to the element, for pasting back into a coding session. */
function describe(element: Element, stop: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== stop && parts.length < 4; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    const slot = node.getAttribute("data-slot"), variant = node.getAttribute("data-variant");
    if (slot) part += `[data-slot="${slot}"]`;
    if (variant) part += `[data-variant="${variant}"]`;
    const classes = Array.from(node.classList).filter(name => !name.startsWith("lab-")).slice(0, 2);
    if (classes.length) part += `.${classes.join(".")}`;
    parts.unshift(part);
    if (classes.length && parts.length > 1) break;
  }
  const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `${parts.join(" > ")}${text ? ` «${text}»` : ""}`;
}

/** One story alone at the window's own size, so the app's viewport media queries really apply. */
function LabFrame({ id }: { id: string }) {
  const story = stories.find(item => item.id === id) ?? stories[0]!;
  useEffect(() => { const theme = read(STORAGE.theme); applyTheme(THEME_IDS.includes(theme as ThemeId) ? theme as ThemeId : "meluli-dark"); setLabScheme((read(STORAGE.scheme) as LabScheme) || "dark"); }, []);
  useEffect(() => { document.title = `${story.name} — Meluli Lab`; }, [story.name]);
  return <div className="lab-canvas lab-frame">{story.render()}</div>;
}

const FRAME = { width: 720, height: 560 };

export function LabApp() {
  const frame = new URLSearchParams(window.location.search).get("frame");
  return frame ? <LabFrame id={frame} /> : <LabWorkbench />;
}

function LabWorkbench() {
  usePointerFeedback();
  const [storyId, setStoryId] = useState(() => read(STORAGE.story) ?? stories[0]!.id);
  const [theme, setTheme] = useState<ThemeId>(() => { const saved = read(STORAGE.theme); return THEME_IDS.includes(saved as ThemeId) ? saved as ThemeId : "meluli-dark"; });
  const [scheme, setScheme] = useState<LabScheme>(() => (read(STORAGE.scheme) as LabScheme) || "dark");
  const [width, setWidth] = useState<Width>(() => (read(STORAGE.width) as Width) in WIDTHS ? read(STORAGE.width) as Width : "window");
  const [filter, setFilter] = useState("");
  const [notes, setNotes] = useState<Note[]>(readNotes);
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState<{ state: string; target: string; x: number; y: number } | null>(null);
  const [calls, setCalls] = useState<LabCall[]>([]);
  const [panel, setPanel] = useState<"notes" | "calls" | null>(null);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const hovered = useRef<Element | null>(null);

  const story = stories.find(item => item.id === storyId) ?? stories[0]!;
  const groups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const map = new Map<string, typeof stories>();
    for (const item of stories) {
      if (query && !`${item.name} ${item.group} ${item.source}`.toLowerCase().includes(query)) continue;
      map.set(item.group, [...(map.get(item.group) ?? []), item]);
    }
    return [...map];
  }, [filter]);

  useEffect(() => { write(STORAGE.story, story.id); }, [story.id]);
  useEffect(() => { applyTheme(theme); write(STORAGE.theme, theme); }, [theme]);
  useEffect(() => { setLabScheme(scheme); write(STORAGE.scheme, scheme); }, [scheme]);
  useEffect(() => { write(STORAGE.width, width); }, [width]);
  useEffect(() => { write(STORAGE.notes, JSON.stringify(notes)); }, [notes]);
  useEffect(() => onLabCall(call => setCalls(current => [call, ...current].slice(0, 80))), []);

  const pickTheme = (next: ThemeId) => {
    setTheme(next);
    const mode = THEMES[next].mode;
    if (mode !== "system") setScheme(mode);
  };

  // Comment mode: hovering outlines an element, a click opens a note instead of acting.
  useEffect(() => {
    const root = canvas.current;
    if (!root || !commenting) return;
    const clear = () => { hovered.current?.removeAttribute("data-lab-hover"); hovered.current = null; };
    const over = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.closest(".lab-state-body") || target === hovered.current) return;
      clear(); target.setAttribute("data-lab-hover", ""); hovered.current = target;
    };
    const swallow = (event: Event) => { if ((event.target as Element)?.closest?.(".lab-state-body")) { event.preventDefault(); event.stopPropagation(); } };
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const frame = target?.closest(".lab-state");
      if (!target || !frame) return;
      event.preventDefault(); event.stopPropagation();
      setDraft({ state: frame.getAttribute("data-lab-state") ?? "", target: describe(target, frame), x: event.clientX, y: event.clientY });
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerdown", swallow, true);
    root.addEventListener("mousedown", swallow, true);
    root.addEventListener("click", click, true);
    return () => {
      clear();
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerdown", swallow, true);
      root.removeEventListener("mousedown", swallow, true);
      root.removeEventListener("click", click, true);
    };
  }, [commenting, storyId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (draft || commenting)) { setDraft(null); if (!draft) setCommenting(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, commenting]);

  const saveNote = (text: string) => {
    if (!draft || !text.trim()) { setDraft(null); return; }
    setNotes(current => [...current, { id: crypto.randomUUID(), story: `${story.name} (src/renderer/${story.source})`, state: draft.state, target: draft.target, text: text.trim(), at: Date.now() }]);
    setDraft(null);
    setPanel("notes");
  };

  const exportNotes = async () => {
    const byStory = new Map<string, Note[]>();
    for (const note of notes) byStory.set(note.story, [...(byStory.get(note.story) ?? []), note]);
    const text = ["# Meluli Lab — הערות פוליש", `ערכה: ${THEMES[theme].label} · ${scheme}`, ""]
      .concat(...[...byStory].map(([name, items]) => [`## ${name}`, ...items.map(note => `- [${note.state}] \`${note.target}\` — ${note.text}`), ""]))
      .join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  return <div className="lab" data-commenting={commenting || undefined}>
    <aside className="lab-sidebar">
      <header className="lab-brand"><strong>Meluli Lab</strong><span>רכיבים על נתוני דמה · מקומי בלבד</span></header>
      <input className="lab-filter" type="search" placeholder="חיפוש רכיב…" value={filter} onChange={event => setFilter(event.target.value)} />
      <nav>
        {groups.map(([group, items]) => <section key={group}>
          <h3>{group}</h3>
          {items.map(item => <button key={item.id} type="button" aria-current={item.id === story.id ? "page" : undefined} onClick={() => setStoryId(item.id)}>
            {item.name}
            {notes.some(note => note.story.startsWith(`${item.name} (`)) && <span className="lab-dot" aria-label="יש הערות" />}
          </button>)}
        </section>)}
      </nav>
    </aside>

    <div className="lab-main">
      <header className="lab-toolbar">
        <div className="lab-title"><h2>{story.name}</h2><code dir="ltr">src/renderer/{story.source}</code></div>
        <div className="lab-controls">
          <label>ערכה<select value={theme} onChange={event => pickTheme(event.target.value as ThemeId)}>{THEME_IDS.map(id => <option key={id} value={id}>{THEMES[id].label}</option>)}</select></label>
          <label>מצב<select value={scheme} onChange={event => setScheme(event.target.value as LabScheme)}><option value="dark">כהה</option><option value="light">בהיר</option><option value="system">לפי המערכת</option></select></label>
          <label>רוחב<select value={width} onChange={event => setWidth(event.target.value as Width)}>{Object.entries(WIDTHS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button type="button" className="lab-toggle" title="פותח את הרכיב בחלון בגודל המינימלי של האפליקציה" onClick={() => window.open(`${window.location.pathname}?frame=${encodeURIComponent(story.id)}`, "meluli-lab-frame", `popup,width=${FRAME.width},height=${FRAME.height}`)}>חלון {FRAME.width}×{FRAME.height}</button>
          <button type="button" className="lab-toggle" aria-pressed={commenting} onClick={() => { setCommenting(!commenting); setDraft(null); }}>{commenting ? "סיום הערות" : "מצב הערות"}</button>
          <button type="button" className="lab-toggle" aria-pressed={panel === "notes"} onClick={() => setPanel(panel === "notes" ? null : "notes")}>הערות ({notes.length})</button>
          <button type="button" className="lab-toggle" aria-pressed={panel === "calls"} onClick={() => setPanel(panel === "calls" ? null : "calls")}>פעולות ({calls.length})</button>
        </div>
      </header>
      {commenting && <p className="lab-hint">לוחצים על כל חלק ברכיב כדי לכתוב הערה. Esc לביטול.</p>}

      <div ref={canvas} className="lab-canvas" data-width={width} key={`${story.id}:${theme}:${scheme}`}>
        {story.render()}
      </div>
    </div>

    {panel && <aside className="lab-panel">
      {panel === "notes" ? <>
        <header><h3>הערות פוליש</h3>
          <div><button type="button" onClick={() => void exportNotes()} disabled={!notes.length}>{copied ? "הועתק" : "העתקה כ-Markdown"}</button>
            <button type="button" onClick={() => { if (confirm("למחוק את כל ההערות?")) setNotes([]); }} disabled={!notes.length}>מחיקת הכול</button></div>
        </header>
        {!notes.length && <p className="lab-empty">עוד אין הערות. מפעילים "מצב הערות" ולוחצים על רכיב.</p>}
        <ol>{notes.map(note => <li key={note.id}>
          <small>{note.story.split(" (")[0]} · {note.state}</small>
          <code dir="ltr">{note.target}</code>
          <p>{note.text}</p>
          <button type="button" onClick={() => setNotes(current => current.filter(item => item.id !== note.id))}>מחיקה</button>
        </li>)}</ol>
      </> : <>
        <header><h3>מה הרכיב היה עושה</h3><div><button type="button" onClick={() => setCalls([])}>ניקוי</button></div></header>
        <p className="lab-empty">כל קריאה נענית כאן בדמה. שום דבר לא מגיע לאפליקציה, לדיסק או לרשת.</p>
        <ol className="lab-calls">{calls.map(call => <li key={call.id} dir="ltr"><code>{call.path}</code>{call.args && <small>({call.args})</small>}</li>)}</ol>
      </>}
    </aside>}

    {draft && <NoteDraft draft={draft} onSave={saveNote} onCancel={() => setDraft(null)} />}
  </div>;
}

function NoteDraft({ draft, onSave, onCancel }: { draft: { state: string; target: string; x: number; y: number }; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const left = Math.min(draft.x, window.innerWidth - 340), top = Math.min(draft.y + 12, window.innerHeight - 220);
  return <form className="lab-draft" style={{ left, top }} onSubmit={event => { event.preventDefault(); onSave(text); }}>
    <small>{draft.state}</small>
    <code dir="ltr">{draft.target}</code>
    <textarea autoFocus rows={3} value={text} placeholder="מה לשפר כאן? (⌘↵ לשמירה)" onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && event.metaKey) { event.preventDefault(); onSave(text); } }} />
    <div><button type="submit">שמירה</button><button type="button" onClick={onCancel}>ביטול</button></div>
  </form>;
}
