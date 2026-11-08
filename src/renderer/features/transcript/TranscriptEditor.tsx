import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { useKeepMainWindow } from "@/lib/keep-main-window";
import { formatDurationMs } from "@/lib/format";
import { he } from "@shared/locale";
import { getTranscriptCues } from "@shared/transcript-cues";
import type { TranscriptEdit, TranscriptRecord } from "@shared/types";

const saveFailed = "השינויים לא נשמרו. אפשר לנסות שוב.";

/** What a save changed, line by line, so the reader can offer to teach the dictionary. */
export interface SavedEdit { before: string[]; after: string[] }

/** Edits cue by cue when timings exist, so subtitles stay aligned; otherwise the whole text. */
export function TranscriptEditor({ transcript, onDone, focusWord }: {
  transcript: TranscriptRecord;
  onDone: (saved?: SavedEdit) => void;
  /** Opens with this word selected, so typing replaces it. */
  focusWord?: string;
}) {
  const { transcripts, setErrorMessage } = useAppContext();
  // The draft is measured against the version it was opened on, even if a newer one arrives.
  const [opened] = useState(transcript);
  const cues = useMemo(() => getTranscriptCues(opened), [opened]);
  const timed = cues.length > 0;
  const [cueTexts, setCueTexts] = useState(() => cues.map(cue => cue.text));
  const [text, setText] = useState(opened.text);
  const [saving, setSaving] = useState(false);
  const [blank, setBlank] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const savePending = useRef(false);
  const finished = useRef(false);
  const edit: TranscriptEdit = timed ? { cueTexts } : { text };
  const dirty = timed ? cueTexts.some((value, index) => value !== cues[index]?.text) : text !== opened.text;
  // Closing the window must not drop an edit: the hidden window stays until it is saved or canceled.
  useKeepMainWindow(dirty || saving);
  const empty = timed ? cueTexts.every(value => !value.trim()) : !text.trim();

  // Only on opening: the word to start from does not change while editing.
  const openingWord = useRef(focusWord);
  useLayoutEffect(() => {
    const word = openingWord.current;
    const fields = [...area.current?.querySelectorAll("textarea") ?? []];
    const field = (word && fields.find(item => item.value.includes(word))) || fields[0];
    field?.focus();
    const at = word && field ? field.value.indexOf(word) : -1;
    if (field && word && at >= 0) field.setSelectionRange(at, at + word.length);
  }, []);

  const finish = (saved?: SavedEdit) => { finished.current = true; onDone(saved); };
  // Another editor (Home's tray and History can both hold one) may save this transcript first.
  // Untouched, this editor just closes. With a draft it stays open and never saves on its own,
  // so only the person decides whether the draft replaces the newer text.
  // A record fresh from a dictation has no `editedAt`; one read back from history has null.
  const superseded = transcript.text !== opened.text || (transcript.editedAt ?? null) !== (opened.editedAt ?? null);
  useEffect(() => {
    if (!superseded || dirty) return;
    const timer = window.setTimeout(() => { if (!finished.current && !savePending.current) finish(); });
    return () => window.clearTimeout(timer);
  });
  const save = async () => {
    if (savePending.current) return;
    if (!dirty) return finish();
    if (empty) return setBlank(true);
    savePending.current = true;
    setSaving(true);
    try {
      if (!await transcripts.updateTranscript(opened.id, edit)) throw new Error("Transcript was not saved");
      finish(timed ? { before: cues.map(cue => cue.text), after: cueTexts } : { before: [opened.text], after: [text] });
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
    if (finished.current || savePending.current || superseded || !dirty || empty) return;
    transcripts.updateTranscript(opened.id, edit).catch(() => setErrorMessage(saveFailed));
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
      <Button ref={cancelButton} size="sm" variant="ghost" disabled={saving} focusableWhenDisabled onClick={() => finish()}>{he.reset}</Button>
      {blank && empty ? <span className="transcript-edit-note" role="alert">אי אפשר לשמור תמלול ריק.</span>
        : superseded && dirty && !saving ? <span className="transcript-edit-note" role="status">{he.transcriptChangedElsewhere}</span>
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
