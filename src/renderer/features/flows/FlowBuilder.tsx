import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Branch, Clipboard, Microphone, Plus, Sparkles, Trash, X } from "@/components/icons";
import { InlineConfirm } from "@/components/InlineConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context/app-context";
import { AudioCaptureController } from "@/lib/audio-capture";
import {
  MAX_FLOW_STEPS, MAX_INSTRUCTION_CHARS, ORIGINAL_TOKEN, assignApp,
  type Flow, type FlowApp, type FlowResult, type FlowStep, type FlowStepTrace
} from "@shared/flows";
import { connectionLabel, destination, failureCopy, forSave, newId, type ConnectionView } from "./flow-copy";

type Run =
  | { phase: "recording" }
  | { phase: "transcribing" }
  | { phase: "running"; source: string }
  | { phase: "done"; source: string; trace: FlowStepTrace[]; result: FlowResult }
  | { phase: "error"; message: string };

export function FlowBuilder({ flow, flows, connections, apps, onConnect, onFlows, onBack, onDelete }: {
  flow: Flow; flows: Flow[]; connections: ConnectionView[]; apps: FlowApp[] | null;
  /** Opens the connect screen for a step: a new connection, or a key for an existing one. */
  onConnect: (stepId: string, editId?: string) => void;
  onFlows: (flows: Flow[]) => void; onBack: () => void; onDelete: () => void;
}) {
  const { settings } = useAppContext();
  const [moved, setMoved] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const capture = useRef<AudioCaptureController | null>(null);
  const runToken = useRef(0);
  const nameId = useId(), enabledId = useId(), deliveryId = useId(), addAppId = useId();
  useEffect(() => () => { runToken.current++; void capture.current?.destroy(); }, []);

  const onChange = (next: Flow) => onFlows(flows.map(f => f.id === next.id ? next : f));
  // An edit makes an earlier test result stale; a run still in flight is dropped too.
  const setSteps = (steps: FlowStep[]) => { onChange({ ...flow, steps }); if (run?.phase === "done" || run?.phase === "running") { runToken.current++; setRun(null); } };
  const patchStep = (id: string, patch: Partial<FlowStep>) => setSteps(flow.steps.map(step => step.id === id ? { ...step, ...patch } as FlowStep : step));
  const move = (index: number, by: -1 | 1) => {
    const steps = [...flow.steps];
    const [step] = steps.splice(index, 1);
    steps.splice(index + by, 0, step!);
    setSteps(steps);
  };
  const llmCount = flow.steps.filter(s => s.kind === "llm").length;
  const full = flow.steps.length >= MAX_FLOW_STEPS;

  const startTest = async () => {
    const token = ++runToken.current;
    const controller = new AudioCaptureController();
    capture.current = controller;
    setRun({ phase: "recording" });
    try {
      await controller.start(settings?.microphoneDeviceId ?? null);
    } catch {
      if (token === runToken.current) setRun({ phase: "error", message: "אין גישה למיקרופון. אפשר לאשר בהגדרות המערכת." });
      capture.current = null;
    }
  };
  const finishTest = async () => {
    const controller = capture.current;
    if (!controller) return;
    capture.current = null;
    const token = runToken.current;
    setRun({ phase: "transcribing" });
    try {
      const audio = await controller.stop();
      const source = (await window.ivritMenuBar.flows.testDictation(audio)).trim();
      if (token !== runToken.current) return;
      if (!source) { setRun({ phase: "error", message: "לא נשמע דיבור. אפשר לנסות שוב, קרוב יותר למיקרופון." }); return; }
      setRun({ phase: "running", source });
      const outcome = await window.ivritMenuBar.flows.testRun(forSave(flow), source);
      if (token === runToken.current) setRun({ phase: "done", source, trace: outcome.trace, result: outcome.result });
    } catch {
      if (token === runToken.current) setRun({ phase: "error", message: "הניסיון לא רץ. אם יש הקלטה פעילה, אפשר לסיים אותה ולנסות שוב." });
    } finally {
      void controller.destroy();
    }
  };

  const removeApp = (bundleId: string) => { onChange({ ...flow, apps: flow.apps.filter(a => a.bundleId !== bundleId) }); setMoved(null); };
  const addApp = (bundleId: string) => {
    const app = apps?.find(a => a.bundleId === bundleId);
    if (!app) return;
    const { flows: next, movedFrom } = assignApp(flows, flow.id, app);
    onFlows(next);
    setMoved(movedFrom ? `${app.name} הועבר מ"${movedFrom}".` : null);
  };

  const trace = run?.phase === "done" ? new Map(run.trace.map(t => [t.stepId, t])) : null;
  const source = run && "source" in run ? run.source : null;
  const totalMs = run?.phase === "done" ? run.trace.reduce((sum, t) => sum + (t.kind === "llm" && t.status === "done" ? t.ms : 0), 0) : 0;
  const requests = run?.phase === "done" ? run.trace.filter(t => t.kind === "llm" && t.status !== "skipped").length : 0;

  return <div className="settings-page flow-builder">
    <div className="flow-builder-head">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowRight />פעולות</Button>
      <span className="flow-builder-where">{destination(flow, connections)}</span>
    </div>

    <div className="flow-title-row">
      <label className="sr-only" htmlFor={nameId}>שם הפעולה</label>
      <Input id={nameId} className="flow-name" dir="auto" maxLength={60} value={flow.name} onChange={event => onChange({ ...flow, name: event.target.value })} />
      <span id={enabledId} className="flow-enabled-label">{flow.enabled ? "פעיל" : "כבוי"}</span>
      <Switch checked={flow.enabled} aria-labelledby={enabledId} onCheckedChange={enabled => onChange({ ...flow, enabled })} />
    </div>

    <ol className="flow-steps">
      <li className="flow-card" data-kind="source">
        <CardHead icon={<Microphone />} title="הכתבה" sub={flow.apps.length ? "רץ כשמכתיבים ב:" : "נבחר מהחלון הצף בזמן ההקלטה"} />
        <div className="flow-apps">
          {flow.apps.map(app => <span key={app.bundleId} className="flow-chip"><bdi dir="ltr">{app.name}</bdi>
            <Button variant="ghost" size="icon-xs" aria-label={`הסרת ${app.name}`} onClick={() => removeApp(app.bundleId)}><X /></Button></span>)}
          <label className="sr-only" htmlFor={addAppId}>הוספת אפליקציה</label>
          <Select id={addAppId} className="flow-add-app" value="" disabled={!apps} onChange={event => addApp(event.target.value)}>
            <option value="">{apps ? "הוספת אפליקציה…" : "טוען אפליקציות…"}</option>
            {apps?.filter(app => !flow.apps.some(a => a.bundleId === app.bundleId)).map(app => {
              const owner = flows.find(other => other.id !== flow.id && other.apps.some(a => a.bundleId === app.bundleId));
              return <option key={app.bundleId} value={app.bundleId}>{app.name}{owner ? ` (כרגע ב"${owner.name}")` : ""}</option>;
            })}
          </Select>
        </div>
        {moved && <p className="flow-note" role="status">{moved}</p>}
        {source && <div className="flow-run"><p dir="auto">{source}</p></div>}
      </li>

      {flow.steps.map((step, index) => {
        const result = trace?.get(step.id);
        const status = run?.phase === "running" ? "running" : result ? (result.status === "skipped" ? "skipped" : result.status === "failed" ? "failed" : "done") : undefined;
        return <li key={step.id} className="flow-card" data-kind={step.kind} data-status={status}>
          <CardHead icon={step.kind === "llm" ? <Sparkles /> : <Branch />} title={step.kind === "llm" ? "צעד מודל" : "תנאי"}>
            <span className="flow-card-tools">
              <Button variant="ghost" size="icon-xs" aria-label="העברה למעלה" disabled={index === 0} focusableWhenDisabled onClick={() => move(index, -1)}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-xs" aria-label="העברה למטה" disabled={index === flow.steps.length - 1} focusableWhenDisabled onClick={() => move(index, 1)}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-xs" aria-label="מחיקת הצעד" disabled={step.kind === "llm" && llmCount === 1} focusableWhenDisabled
                onClick={() => setSteps(flow.steps.filter(s => s.id !== step.id))}><Trash /></Button>
            </span>
          </CardHead>
          {step.kind === "llm" ? <LlmStep step={step} connections={connections} onConnect={editId => onConnect(step.id, editId)} isFirst={flow.steps.findIndex(s => s.kind === "llm") === index}
            onChange={patch => patchStep(step.id, patch)} />
          : <div className="flow-condition">
            <span>ממשיכים לצעד הבא רק אם בטקסט</span>
            <Select aria-label="סוג התנאי" value={step.op} onChange={event => patchStep(step.id, { op: event.target.value as "min" | "max" })}>
              <option value="min">לפחות</option><option value="max">לכל היותר</option>
            </Select>
            <WordsInput value={step.words} onChange={words => patchStep(step.id, { words })} />
            <span>מילים.</span>
          </div>}
          {result && <StepResult trace={result} connections={connections} step={step} />}
        </li>;
      })}

      <li className="flow-add">
        <Button variant="ghost" size="sm" disabled={full} focusableWhenDisabled
          onClick={() => setSteps([...flow.steps, { id: newId("step"), kind: "llm", instruction: "", connectionId: null }])}><Plus />צעד מודל</Button>
        <Button variant="ghost" size="sm" disabled={full} focusableWhenDisabled
          onClick={() => setSteps([...flow.steps, { id: newId("step"), kind: "if", op: "min", words: 5 }])}><Plus />תנאי</Button>
      </li>

      <li className="flow-card" data-kind="paste">
        <CardHead icon={<Clipboard />} title={<label htmlFor={deliveryId}>הדבקה</label>} />
        <Select id={deliveryId} value={flow.delivery} onChange={event => onChange({ ...flow, delivery: event.target.value as Flow["delivery"] })}>
          <option value="paste">מדביק מיד, עם חזרה למקור</option>
          <option value="preview">תצוגה מקדימה לפני ההדבקה</option>
        </Select>
        <p className="flow-hint">{flow.delivery === "paste"
          ? "התוצאה נכנסת מיד. בחלון הצף אפשר לחזור לתמלול המקורי."
          : "לחיצה קצרה על מקש ההכתבה מדביקה. Esc מדביק את המקור."} אם צעד נכשל, נכנס התמלול המקורי.</p>
      </li>
    </ol>

    <div className="workspace-setup-status flow-test" data-phase={run?.phase}>
      <span className="source-icon"><Microphone /></span>
      <div className="workspace-setup-copy" role="status">
        <strong>{run?.phase === "recording" ? <span className="flow-test-live"><span className="led" data-tone="live" />מקליט</span> : "הכתבת ניסיון"}</strong>
        <p>{run?.phase === "recording" ? "דברו כרגיל, ואז סיום."
          : run?.phase === "transcribing" ? "מתמלל…"
          : run?.phase === "running" ? "מריץ את הצעדים…"
          : run?.phase === "error" ? run.message
          : run?.phase === "done" ? run.result.ok
            ? `${(totalMs / 1000).toFixed(1)} שנ׳ בסך הכל, ${requests === 1 ? "בקשה אחת" : `${requests} בקשות`}. שום דבר לא הודבק.`
            : `${failureCopy(run.result.reason)} בהכתבה אמיתית היה נכנס התמלול המקורי.`
          : "מקליטים כאן ורואים מה כל צעד מחזיר. שום דבר לא מודבק ולא נשמר."}</p>
      </div>
      {run?.phase === "recording" ? <Button size="sm" onClick={() => void finishTest()}>סיום</Button>
        : <Button size="sm" disabled={run?.phase === "transcribing" || run?.phase === "running" || !connections.length} focusableWhenDisabled
          onClick={() => void startTest()}>{run ? "עוד פעם" : "התחלה"}</Button>}
    </div>

    {confirmDelete ? <InlineConfirm title={`למחוק את \u2068"${flow.name}"\u2069?`} confirmLabel="מחיקת הפעולה" onConfirm={onDelete} onCancel={() => setConfirmDelete(false)}
      body={flow.apps.length ? `${flow.apps.map(app => app.name).join(", ")} יחזרו להכתבה רגילה. אי אפשר לבטל.` : "אי אפשר לבטל."} /> : <div><Button size="sm" variant="ghost" className="flow-delete" onClick={() => setConfirmDelete(true)}>מחיקת הפעולה</Button></div>}
  </div>;
}

function StepResult({ trace, step, connections }: { trace: FlowStepTrace; step: FlowStep; connections: ConnectionView[] }) {
  if (trace.kind === "if") return <p className="flow-run-note">{`${trace.words} מילים · ${trace.status === "passed" ? "התקיים" : "לא התקיים, הצעד הבא ידולג"}`}</p>;
  if (trace.status === "skipped") return <p className="flow-run-note">דולג: התנאי לא התקיים</p>;
  if (trace.status === "failed") {
    const connection = step.kind === "llm" ? (step.connectionId ? connections.find(c => c.id === step.connectionId) : connections[0]) : undefined;
    return <div className="flow-run" data-status="failed"><p className="flow-run-meta">{failureCopy(trace.reason, connection?.local)}</p></div>;
  }
  return <div className="flow-run" data-status="done">
    <p dir="auto">{trace.output}</p>
    <p className="flow-run-meta">{`${(trace.ms / 1000).toFixed(1)} שנ׳`}</p>
  </div>;
}

const clampWords = (value: number) => Math.min(10_000, Math.max(1, Math.round(value) || 1));

/** The field keeps what is typed, even an empty moment while replacing the number; the step gets the clamped count. */
function WordsInput({ value, onChange }: { value: number; onChange: (words: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(current => current.trim() !== "" && clampWords(Number(current)) === value ? current : String(value)); }, [value]);
  return <Input aria-label="מספר מילים" type="number" min={1} max={10000} inputMode="numeric" className="flow-words" value={draft}
    onChange={event => { const next = event.target.value; setDraft(next); if (next.trim() !== "") onChange(clampWords(Number(next))); }}
    onBlur={() => setDraft(String(value))} />;
}

function CardHead({ icon, title, sub, children }: { icon: ReactNode; title: ReactNode; sub?: string; children?: ReactNode }) {
  return <div className="flow-card-head">
    <span className="flow-card-icon">{icon}</span>
    <span className="flow-card-kind">{title}</span>
    {sub && <span className="flow-card-sub">{sub}</span>}
    {children}
  </div>;
}

const NEW_CONNECTION = "__new";

function LlmStep({ step, connections, isFirst, onChange, onConnect }: {
  step: Extract<FlowStep, { kind: "llm" }>; connections: ConnectionView[]; isFirst: boolean; onChange: (patch: Partial<FlowStep>) => void;
  onConnect: (editId?: string) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const instructionId = useId(), connectionId = useId();
  const fallback = connections[0];
  const insertOriginal = () => {
    const el = area.current;
    const at = el?.selectionStart ?? step.instruction.length;
    const next = `${step.instruction.slice(0, at)}${ORIGINAL_TOKEN}${step.instruction.slice(at)}`.slice(0, MAX_INSTRUCTION_CHARS);
    onChange({ instruction: next });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + ORIGINAL_TOKEN.length, at + ORIGINAL_TOKEN.length); });
  };
  // A step whose connection was removed shows the default it now falls back to.
  const selected = step.connectionId && connections.some(c => c.id === step.connectionId) ? step.connectionId : "";
  const used = (selected ? connections.find(c => c.id === selected) : fallback) ?? null;
  return <div className="flow-llm">
    <label className="sr-only" htmlFor={instructionId}>הוראה למודל</label>
    <textarea ref={area} id={instructionId} className="flow-instruction" dir="auto" rows={3} maxLength={MAX_INSTRUCTION_CHARS}
      placeholder="מה המודל צריך לעשות עם הטקסט? למשל: נסח מייל קצר ואדיב."
      value={step.instruction} onChange={event => onChange({ instruction: event.target.value })} />
    <div className="flow-llm-foot">
      {/* The model and its API key are picked here, so a step never needs a trip to another page. */}
      {connections.length ? <>
        <label className="sr-only" htmlFor={connectionId}>מודל</label>
        <Select id={connectionId} value={selected} onChange={event => event.target.value === NEW_CONNECTION ? onConnect() : onChange({ connectionId: event.target.value || null })}>
          <option value="">ברירת מחדל ({fallback ? `${connectionLabel(fallback)} · ${fallback.model}` : "אין חיבור"})</option>
          {connections.map(c => <option key={c.id} value={c.id}>{connectionLabel(c)} · {c.model}</option>)}
          <option value={NEW_CONNECTION}>מודל אחר, עם מפתח API…</option>
        </Select>
      </> : <Button variant="secondary" size="sm" onClick={() => onConnect()}><Plus />בחירת מודל ומפתח API</Button>}
      {!isFirst && <Button variant="ghost" size="sm" onClick={insertOriginal}><Plus />הכתבה מקורית</Button>}
    </div>
    {used && !used.ready && <p className="flow-note" role="status">{used.local ? "החיבור הזה לא מוכן." : "לחיבור הזה חסר מפתח API."}
      {!used.local && <Button variant="link" size="sm" onClick={() => onConnect(used.id)}>הוספת מפתח</Button>}</p>}
    <p className="flow-hint">{isFirst ? "עובד על ההכתבה." : "עובד על הפלט של הצעד הקודם. ההכתבה המקורית נשלחת רק אם מכניסים אותה להוראה."}</p>
  </div>;
}
