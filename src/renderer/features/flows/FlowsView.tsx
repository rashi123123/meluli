import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LoadingMark } from "@/components/LoadingMark";
import { ArrowRight, Bubble, Envelope, Globe, Plus, Sparkles, Terminal, Wand } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/features/settings/SettingsRow";
import {
  FLOW_PROVIDERS, FLOW_TEMPLATES, MAX_FLOWS, MAX_FLOW_CONNECTIONS, flowHost, providerPreset,
  type Flow, type FlowApp, type FlowIcon, type FlowProviderId, type FlowStep, type FlowTemplate
} from "@shared/flows";
import { isLoopbackHost } from "@shared/loopback";
import type { FlowsState } from "@shared/types";
import { FlowBuilder } from "./FlowBuilder";
import { connectionLabel, destination, failureCopy, forSave, newId, type ConnectionView } from "./flow-copy";
import "./flows.css";

/** A connect screen opened from a model step goes back to that step and points it at the new connection. */
type ConnectReturn = { flowId: string; stepId: string };
type Screen = { kind: "list" } | { kind: "builder"; id: string }
  | { kind: "connect"; templateId: string | null; returnTo?: ConnectReturn; editId?: string };

const api = () => window.ivritMenuBar.flows;
const SAVE_DELAY_MS = 400;

const ICONS: Record<FlowIcon, typeof Wand> = { sparkles: Sparkles, envelope: Envelope, globe: Globe, bubble: Bubble, terminal: Terminal, wand: Wand };
function FlowGlyph({ icon }: { icon: FlowIcon }) { const Icon = ICONS[icon]; return <span className="source-icon"><Icon /></span>; }

const appsLabel = (apps: FlowApp[]): ReactNode => apps.length ? <bdi dir="ltr">{apps.map(app => app.name).join(", ")}</bdi> : "בלי אפליקציה";
/** Fits one footer line: the first app, then a count, so nothing is cut mid-name. */
const appsShort = (apps: FlowApp[]): ReactNode => apps.length > 2
  ? <><bdi dir="ltr">{apps[0]!.name}</bdi> ועוד {apps.length - 1}</> : appsLabel(apps);

function fromTemplate(template: FlowTemplate | undefined, installed: FlowApp[] | null, taken: Set<string>): Flow {
  const steps: FlowStep[] = template
    ? template.steps.map(step => ({ ...step, id: newId("step") }) as FlowStep)
    : [{ id: newId("step"), kind: "llm", instruction: "", connectionId: null }];
  // A template suggests apps; only installed ones that no other flow holds are added.
  const apps = (template?.apps ?? []).flatMap(app => {
    if (taken.has(app.bundleId)) return [];
    const found = installed?.find(i => i.bundleId === app.bundleId);
    return installed && !found ? [] : [found ?? app];
  });
  return { id: newId("flow"), name: template?.name ?? "פעולה חדשה", icon: template?.icon ?? "wand", apps, steps, delivery: "paste", enabled: true };
}

export function FlowsView() {
  const [state, setState] = useState<FlowsState | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [apps, setApps] = useState<FlowApp[] | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Flow[] | null>(null);
  const timer = useRef<number | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);
  const live = useRef(true);
  const load = useCallback(() => {
    setLoadFailed(false);
    void api().state().then(next => { if (live.current) { setState(next); setFlows(next.flows); } })
      .catch(() => { if (live.current) setLoadFailed(true); });
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    void api().listApps().then(list => live.current && setApps(list)).catch(() => live.current && setApps([]));
    return () => { live.current = false; };
  }, [load]);

  const flush = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    // Local edits stay the source of truth while typing; only the connections come back.
    void api().save(next.map(forSave)).then(saved => setState(current => current ? { ...current, connections: saved.connections } : saved))
      .catch(() => setError("השינוי לא נשמר. אפשר לנסות שוב."));
  }, []);
  useEffect(() => flush, [flush]);

  const commit = (next: Flow[]) => {
    setFlows(next);
    setError(null);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  const connections = state?.connections ?? [];
  const taken = () => new Set(flows.flatMap(flow => flow.apps.map(app => app.bundleId)));
  const add = (templateId: string | null) => {
    if (!connections.length) { setScreen({ kind: "connect", templateId }); return; }
    const flow = fromTemplate(FLOW_TEMPLATES.find(t => t.id === templateId), apps, taken());
    commit([...flows, flow]);
    setScreen({ kind: "builder", id: flow.id });
  };

  if (!state) return loadFailed
    ? <div className="loading-surface" role="alert"><p>לא הצלחנו לטעון את הפעולות.</p><Button size="sm" variant="secondary" onClick={load}>{"ניסיון נוסף"}</Button></div>
    : <div className="loading-surface" role="status"><LoadingMark /></div>;

  // Escape steps back one level, to the list, unless it is closing something inside a field.
  const backOnEscape = (back: () => void) => (event: KeyboardEvent) => {
    const field = event.target;
    if (event.key !== "Escape" || event.defaultPrevented || (field instanceof HTMLElement && (field.matches("input, textarea, select") || field.isContentEditable))) return;
    event.preventDefault();
    back();
  };

  if (screen.kind === "connect") return <div onKeyDown={backOnEscape(() => setScreen(screen.returnTo ? { kind: "builder", id: screen.returnTo.flowId } : { kind: "list" }))}><ConnectScreen key={screen.editId ?? "new"} state={state} existing={state.connections.find(c => c.id === screen.editId)}
    onBack={() => setScreen(screen.returnTo ? { kind: "builder", id: screen.returnTo.flowId } : { kind: "list" })} onConnected={(next, connectionId) => {
    setState(current => current ? { ...current, connections: next.connections } : next);
    const back = screen.returnTo;
    if (back) {
      // An edited key keeps the step as it was; a new connection becomes the step's.
      if (!screen.editId) commit(flows.map(flow => flow.id !== back.flowId ? flow
        : { ...flow, steps: flow.steps.map(step => step.id === back.stepId && step.kind === "llm" ? { ...step, connectionId } : step) }));
      setScreen({ kind: "builder", id: back.flowId });
      return;
    }
    const template = FLOW_TEMPLATES.find(t => t.id === screen.templateId);
    if (!template) { setScreen({ kind: "list" }); return; }
    const flow = fromTemplate(template, apps, taken());
    commit([...flows, flow]);
    setScreen({ kind: "builder", id: flow.id });
  }} /></div>;

  const editing = screen.kind === "builder" ? flows.find(flow => flow.id === screen.id) : undefined;
  if (editing) return <div onKeyDown={backOnEscape(() => { flush(); setScreen({ kind: "list" }); })}><FlowBuilder key={editing.id} flow={editing} flows={flows} connections={connections} apps={apps}
    onConnect={(stepId, editId) => { flush(); setScreen({ kind: "connect", templateId: null, returnTo: { flowId: editing.id, stepId }, editId }); }}
    onFlows={commit} onBack={() => { flush(); setScreen({ kind: "list" }); }}
    onDelete={() => { commit(flows.filter(flow => flow.id !== editing.id)); flush(); setScreen({ kind: "list" }); }} /></div>;

  return <div className="settings-page flows-page">
    {flows.length > 0 ? <section className="settings-group">
      <h3>הפעולות שלך</h3>
      <div className="flow-tiles">
        {flows.map(flow => <FlowTile key={flow.id} flow={flow} where={destination(flow, connections)}
          onOpen={() => setScreen({ kind: "builder", id: flow.id })}
          onToggle={enabled => commit(flows.map(f => f.id === flow.id ? { ...f, enabled } : f))} />)}
      </div>
    </section> : <section className="flows-intro">
      <h3>פעולות</h3>
      <p>פעולה מעבדת את ההכתבה לפני שהיא נכנסת לאפליקציה: מנסחת מייל, מתרגמת, או הופכת עברית מדוברת לפרומפט. התמלול נשאר במחשב, ורק הטקסט של הפעולה נשלח לחיבור שבחרת.</p>
    </section>}
    {error && <p className="flow-note" role="alert">{error}</p>}

    <section className="settings-group">
      <div className="flows-section-head">
        <h3>{flows.length ? "תבניות" : "התחילו מתבנית"}</h3>
        <Button size="sm" variant="ghost" disabled={flows.length >= MAX_FLOWS} focusableWhenDisabled onClick={() => add(null)}><Plus />פעולה ריקה</Button>
      </div>
      <div className="flow-tiles">
        {FLOW_TEMPLATES.map(template => {
          const suggested = template.apps.filter(app => !apps || apps.some(i => i.bundleId === app.bundleId));
          return <button key={template.id} type="button" className="flow-tile" data-kind="template" disabled={flows.length >= MAX_FLOWS} onClick={() => add(template.id)}>
            <span className="flow-tile-top"><FlowGlyph icon={template.icon} /><span className="flow-tile-corner" title="הוספה"><Plus /></span></span>
            <span className="source-title"><strong>{template.name}</strong><span className="flow-tile-summary">{template.summary}</span></span>
            <span className="flow-tile-meta">{appsShort(suggested)}</span>
          </button>;
        })}
      </div>
    </section>

    <Connections state={state} onState={next => setState(current => current ? { ...current, ...next, flows: current.flows } : next)}
      onBeforeChange={flush} onFlowsChanged={next => setFlows(next)} onAdd={() => setScreen({ kind: "connect", templateId: null })}
      onEditKey={id => setScreen({ kind: "connect", templateId: null, editId: id })} />
  </div>;
}

function FlowTile({ flow, where, onOpen, onToggle }: { flow: Flow; where: ReactNode; onOpen: () => void; onToggle: (enabled: boolean) => void }) {
  const titleId = useId();
  // The tile opens the builder; the switch sits beside that button, not inside it.
  return <div className="flow-tile" data-kind="flow" data-off={flow.enabled ? undefined : ""}>
    <button type="button" className="flow-tile-open" aria-labelledby={titleId} onClick={onOpen} />
    <span className="flow-tile-top"><FlowGlyph icon={flow.icon} />
      <Switch checked={flow.enabled} aria-label={`${flow.name} פעיל`} onCheckedChange={onToggle} /></span>
    <span className="source-title"><strong id={titleId}>{flow.name}</strong><span>{appsLabel(flow.apps)}</span></span>
    <span className="flow-tile-meta">{where}</span>
  </div>;
}

function Connections({ state, onState, onBeforeChange, onFlowsChanged, onAdd, onEditKey }: {
  state: FlowsState; onState: (state: FlowsState) => void; onBeforeChange: () => void; onFlowsChanged: (flows: Flow[]) => void; onAdd: () => void;
  onEditKey: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = async (id: string) => {
    // Pending edits reach the main process first, so the delete rewrites the steps that used it.
    onBeforeChange();
    try {
      const next = await api().deleteConnection(id);
      setConfirming(null); setFailure(null);
      onState(next);
      // Steps that used it fall back to the default; the builder must not save the old id back.
      onFlowsChanged(next.flows);
    } catch { setFailure("החיבור לא נמחק. אפשר לנסות שוב."); }
  };
  // Focus goes back to the button that opened the confirm, if its row is still there.
  const list = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef<string | null>(null);
  useEffect(() => {
    const previous = wasConfirming.current;
    wasConfirming.current = confirming;
    if (!confirming && previous) list.current?.querySelector<HTMLElement>(`[data-delete-connection="${CSS.escape(previous)}"]`)?.focus();
  }, [confirming]);
  const cancelConfirm = () => setConfirming(null);
  const makeDefault = async (id: string) => {
    try { onState(await api().makeDefault(id)); setFailure(null); }
    catch { setFailure("ברירת המחדל לא נשמרה. אפשר לנסות שוב."); }
  };
  const test = async (connection: ConnectionView) => {
    setNotice({ id: connection.id, text: "בודק…" });
    const result = await api().testConnection(connection.id).catch(() => null);
    setNotice({ id: connection.id, text: result?.ok ? `עובד. ${((result.latencyMs ?? 0) / 1000).toFixed(1)} שנ׳.` : failureCopy(result?.reason ?? null, connection.local) });
  };
  return <section className="settings-group">
    <h3>חיבורים</h3>
    {failure && <p className="flow-note" role="alert">{failure}</p>}
    <div className="settings-rows" ref={list}>
      {state.connections.map((connection, index) => <SettingsRow key={connection.id}
        title={<>{connectionLabel(connection)} <span className="flows-model" dir="ltr">{connection.model}</span></>}
        description={confirming === connection.id ? "המפתח יימחק, והפעולות שמשתמשות בחיבור יעברו לחיבור ברירת המחדל."
          : notice?.id === connection.id ? <span role="status">{notice.text}</span>
          : !connection.ready ? "לא מוכן: חסר מפתח או מודל."
          : connection.local ? "רץ במחשב. שום טקסט לא יוצא." : <>טקסט נשלח אל <bdi dir="ltr">{connection.host}</bdi>. אושר פעם אחת.</>}>
        {confirming === connection.id ? <span className="flows-row-actions">
          <Button size="sm" variant="secondary" autoFocus onClick={cancelConfirm}>ביטול</Button>
          <Button size="sm" variant="destructive" onClick={() => void remove(connection.id)}>מחיקת החיבור</Button>
        </span> : <span className="flows-row-actions">
          {index === 0 ? <span className="flows-badge">ברירת מחדל</span>
            : <Button size="sm" variant="ghost" onClick={() => void makeDefault(connection.id)}>ברירת מחדל</Button>}
          {!connection.local && <Button size="sm" variant="ghost" onClick={() => onEditKey(connection.id)}>{connection.hasKey ? "החלפת מפתח" : "הוספת מפתח"}</Button>}
          <Button size="sm" variant="ghost" onClick={() => void test(connection)}>בדיקה</Button>
          <Button size="sm" variant="ghost" data-delete-connection={connection.id} onClick={() => setConfirming(connection.id)}>מחיקה</Button>
        </span>}
      </SettingsRow>)}
      {state.connections.length < MAX_FLOW_CONNECTIONS && <SettingsRow title={state.connections.length ? "חיבור נוסף" : "חיבור למודל"}
        description="מפתח API של OpenAI, Anthropic, OpenRouter, Gemini או Groq, Ollama במחשב, או כתובת תואמת OpenAI.">
        <Button size="sm" variant="ghost" onClick={onAdd}>הוספה</Button>
      </SettingsRow>}
    </div>
  </section>;
}

function ConnectScreen({ state, existing, onBack, onConnected }: {
  state: FlowsState; existing?: ConnectionView; onBack: () => void; onConnected: (state: FlowsState, connectionId: string) => void;
}) {
  // Editing keeps the provider, address and model, and asks only for the key; an empty key keeps the saved one.
  const [providerId, setProviderId] = useState<FlowProviderId>(existing?.providerId ?? "openai");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? providerPreset("openai").baseUrl);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(existing?.model ?? providerPreset("openai").model);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Problems with the key show under the key field, where they can be fixed.
  const [keyError, setKeyError] = useState<string | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const keyId = useId(), modelId = useId(), providerFieldId = useId(), urlId = useId(), keyErrorId = useId();
  const preset = providerPreset(providerId);
  const host = flowHost(baseUrl.trim());
  const local = host !== null && isLoopbackHost(host);
  const needsKey = !local && providerId !== "custom";
  const editableUrl = providerId === "custom" || providerId === "ollama";
  const keyBlocked = needsKey && !state.keyStorageAvailable;
  const keepsKey = Boolean(existing?.hasKey) && host === existing?.host;
  const blocked = host === null || model.trim() === "" || keyBlocked;

  const choose = (id: FlowProviderId) => {
    const next = providerPreset(id);
    setProviderId(id); setBaseUrl(next.baseUrl); setModel(next.model); setError(null); setKeyError(null);
  };
  const connect = async () => {
    if (checking || blocked) return;
    if (needsKey && key.trim() === "" && !keepsKey) {
      setKeyError(`מדביקים כאן את המפתח מ־${preset.label}.`);
      keyInput.current?.focus();
      return;
    }
    setChecking(true); setError(null); setKeyError(null);
    const id = existing?.id ?? newId("conn");
    try {
      // Pressing the button that names the host is the consent for that host.
      const saved = await api().saveConnection({ id, providerId, baseUrl: baseUrl.trim(), model: model.trim() }, key.trim() || null, true);
      if (!saved.consented) { setError("החיבור לא נשמר."); return; }
      // The check sends a fixed sentence, never the user's text.
      const result = await api().testConnection(id);
      if (result.ok) { onConnected(saved.state, id); return; }
      // A new connection that does not work is not kept; an edited one stays, with the error shown.
      if (!existing) await api().deleteConnection(id).catch(() => undefined);
      if (result.reason === "auth" && !local) { setKeyError(failureCopy(result.reason, local)); keyInput.current?.focus(); }
      else setError(failureCopy(result.reason, local));
    } catch (cause) {
      setError(cause instanceof Error && /[֐-׿]/.test(cause.message) ? cause.message.replace(/^[\s\S]*Error: /, "") : "החיבור לא נשמר. כדאי לבדוק את הכתובת.");
    } finally {
      setChecking(false);
    }
  };

  return <div className="settings-page flows-page">
    <div className="info-page-head"><Button variant="ghost" size="sm" onClick={onBack}><ArrowRight />פעולות</Button></div>
    <section className="flows-intro">
      <h3>{existing ? "מפתח API" : "חיבור למודל"}</h3>
      <p>{existing ? "מדביקים מפתח חדש. השאר נשאר כמו שהוא." : "צעד מודל צריך מודל שפה. מלולי לא מגיעה עם מפתח: מדביקים מפתח API משלכם (OpenAI, Anthropic ואחרים), או מריצים מודל במחשב עם Ollama."}</p>
    </section>
    <form className="flows-connect-form" noValidate onSubmit={event => { event.preventDefault(); void connect(); }}>
    <section className="settings-group">
      <div className="settings-rows">
        <SettingsRow title={<label htmlFor={providerFieldId}>ספק</label>}>
          <Select id={providerFieldId} value={providerId} disabled={Boolean(existing)} onChange={event => choose(event.target.value as FlowProviderId)}>
            {FLOW_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.id === "ollama" ? "Ollama (במחשב)" : p.label}</option>)}
          </Select>
        </SettingsRow>
        {editableUrl && <SettingsRow title={<label htmlFor={urlId}>כתובת</label>} description={providerId === "custom" ? "כתובת תואמת OpenAI, עם /v1 בסוף." : undefined}>
          <Input id={urlId} dir="ltr" spellCheck={false} value={baseUrl} disabled={Boolean(existing)} placeholder="https://…/v1" onChange={event => setBaseUrl(event.target.value)} className="flows-field" />
        </SettingsRow>}
        {!local && <SettingsRow title={<label htmlFor={keyId}>מפתח API</label>}
          description={keyBlocked ? "אי אפשר לשמור מפתחות בצורה מאובטחת במחשב הזה." : <>נשמר מוצפן במחשב. {preset.keyUrl && <Button type="button" variant="link" size="sm" onClick={() => void window.ivritMenuBar.files.openExternal(preset.keyUrl!)}>איפה משיגים מפתח</Button>}</>}>
          <Input id={keyId} ref={keyInput} type="password" dir="ltr" autoComplete="off" spellCheck={false} value={key} disabled={keyBlocked}
            aria-invalid={Boolean(keyError) || undefined} aria-describedby={keyError ? keyErrorId : undefined}
            placeholder={keepsKey ? "המפתח השמור נשאר" : providerId === "custom" ? "לא חובה" : providerId === "anthropic" ? "sk-ant-…" : providerId === "openai" ? "sk-…" : undefined} onChange={event => { setKey(event.target.value); setKeyError(null); }} className="flows-field" />
          {keyError && <p id={keyErrorId} className="flows-field-error" role="alert">{keyError}</p>}
        </SettingsRow>}
        <SettingsRow title={<label htmlFor={modelId}>מודל</label>}>
          <Input id={modelId} dir="ltr" spellCheck={false} value={model} placeholder={providerId === "ollama" ? "qwen3:8b" : "שם המודל אצל הספק"}
            onChange={event => setModel(event.target.value)} className="flows-field" />
        </SettingsRow>
      </div>
    </section>
    <div className="inline-confirm">
      <div className="inline-confirm-copy">
        <strong>{host === null ? "הכתובת צריכה להתחיל ב-https://, או להיות כתובת מקומית"
          : local ? "שום טקסט לא יוצא מהמחשב" : <>טקסט של פעולות יישלח אל <bdi dir="ltr">{host}</bdi></>}</strong>
        <p role={error ? "alert" : undefined}>{error ?? (local ? "המודל רץ על המחשב הזה. הוא צריך להיות פתוח בזמן ההכתבה."
          : "רק הטקסט של פעולה שמשתמשת בחיבור הזה. התמלול וההקלטה נשארים במחשב. מאשרים פעם אחת לחיבור.")}</p>
      </div>
      <div className="inline-confirm-actions">
        <Button type="submit" size="sm" aria-disabled={blocked || checking || undefined} aria-busy={checking || undefined}>{existing ? "שמירה ובדיקה" : local || host === null ? "חיבור" : "אישור וחיבור"}</Button>
      </div>
    </div>
    </form>
  </div>;
}
