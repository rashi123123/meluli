import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { formatDurationMs } from "@/lib/format";
import { he } from "@shared/locale";
import { getTranscriptCues } from "@shared/transcript-cues";
import type { TranscriptEdit, TranscriptRecord } from "@shared/types";

const saveFailed = "השינויים לא נשמרו. אפשר לנסות שוב.";

/** Edits cue by cue when timings exist, so subtitles stay aligned; otherwise the whole text. */
export function TranscriptEditor({ transcript, onDone }: { transcript: TranscriptRecord; onDone: () => void }) {
  const { transcripts, setErrorMessage } = useAppContext();
  const cues = useMemo(() => getTranscriptCues(transcript), [transcript]);
  const timed = cues.length > 0;
  const [cueTexts, setCueTexts] = useState(() => cues.map(cue => cue.text));
  const [text, setText] = useState(transcript.text);
  const [saving, setSaving] = useState(false);
  const [blank, setBlank] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const savePending = useRef(false);
  const finished = useRef(false);
  const edit: TranscriptEdit = timed ? { cueTexts } : { text };
  const dirty = timed ? cueTexts.some((value, index) => value !== cues[index]?.text) : text !== transcript.text;
  const empty = timed ? cueTexts.every(value => !value.trim()) : !text.trim();

  useLayoutEffect(() => { area.current?.querySelector("textarea")?.focus(); }, []);

  const finish = () => { finished.current = true; onDone(); };
  const save = async () => {
    if (savePending.current) return;
    if (!dirty) return finish();
    if (empty) return setBlank(true);
    savePending.current = true;
    setSaving(true);
    try {
      if (!await transcripts.updateTranscript(transcript.id, edit)) throw new Error("Transcript was not saved");
      finish();
    } catch {
      setErrorMessage(saveFailed);
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  // Leaving the screen is not a way to lose work: a pending edit saves on the way out.
  const flush = useRef(() => {});
  flush.current = () => {
    if (finished.current || savePending.current || !dirty || empty) return;
    transcripts.updateTranscript(transcript.id, edit).catch(() => setErrorMessage(saveFailed));
  };
  useEffect(() => () => flush.current(), []);

  return <div ref={area} className="transcript-editor" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      // One stray Esc must not throw away corrections: with unsaved text it only reaches Cancel.
      if (dirty && document.activeElement !== cancelButton.current) cancelButton.current?.focus();
      else finish();
    }
    else if (event.key === "s" && event.metaKey) { event.preventDefault(); void save(); }
  }}>
    <div className="transcript-actions">
      <Button size="sm" disabled={saving} focusableWhenDisabled onClick={() => void save()}>{saving ? "שומרים…" : he.save}</Button>
      <Button ref={cancelButton} size="sm" variant="ghost" disabled={saving} focusableWhenDisabled onClick={finish}>{he.reset}</Button>
      {blank && empty ? <span className="transcript-edit-note" role="alert">אי אפשר לשמור תמלול ריק.</span>
        : timed && <span className="transcript-edit-note">תיקון בתוך שורה שומר על התזמון של הכתוביות. שורה שרוקנים נמחקת.</span>}
    </div>
    <div className="transcript-content scroll-region">
      {timed ? <div className="cue-list">{cues.map((cue, index) => <div key={index} className="cue-row">
        <span className="cue-time" dir="ltr">{formatDurationMs(cue.start * 1000)}</span>
        <textarea className="transcript-field" rows={1} dir="auto" value={cueTexts[index]} aria-label={`שורה ${index + 1}, ${formatDurationMs(cue.start * 1000)}`}
          onChange={(event) => { const value = event.target.value; setCueTexts(current => current.map((item, position) => position === index ? value : item)); }} />
      </div>)}</div> : <textarea className="transcript-field transcript-field-free" dir="auto" value={text} aria-label="טקסט התמלול" onChange={(event) => setText(event.target.value)} />}
    </div>
  </div>;
}
