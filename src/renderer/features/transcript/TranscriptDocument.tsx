import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { CopyButton } from "@/components/CopyButton";
import { ArrowClockwise, ArrowSquareOut, DownloadSimple, Pencil, Restore, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { InlineConfirm } from "@/components/InlineConfirm";
import { useAppContext } from "@/context/app-context";
import { useTranscriptActions } from "@/hooks/use-transcript-actions";
import { useTranscriptPlayback } from "@/hooks/use-transcript-playback";
import { formatDate, formatTranscriptDurationMs } from "@/lib/format";
import { splitSuspects } from "@/lib/suspect-words";
import { getTranscriptTitle } from "@shared/transcript-title";
import { he } from "@shared/locale";
import { suggestDictionaryEntries } from "@shared/dictionary-suggestions";
import { getTranscriptCues } from "@shared/transcript-cues";
import type { TranscriptRecord } from "@shared/types";
import { DictionarySuggestions, type OfferedSuggestion } from "./DictionarySuggestions";
import { TranscriptEditor, type SavedEdit } from "./TranscriptEditor";
import { TranscriptPlayer } from "./TranscriptPlayer";
import { wordCount } from "@shared/flows";

const toParagraphs = (text: string) => text.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean);
const countWords = (text: string) => {
  const count = wordCount(text);
  return count === 1 ? "מילה אחת" : `${count} מילים`;
};

/** Offered while the recording behind a transcript is still kept on disk. */
export interface TranscribeAgainAction {
  busy: boolean;
  disabled: boolean;
  run: () => void;
}

/** One transcript, read or edited in place. Render with key={transcript.id}. */
export function TranscriptDocument({ transcript, trailing, onClose, transcribeAgain, recordingId }: {
  transcript: TranscriptRecord;
  trailing?: ReactNode;
  onClose?: () => void;
  transcribeAgain?: TranscribeAgainAction;
  /** The kept recording behind this transcript, for playback. */
  recordingId?: string | null;
}) {
  const { transcripts, setErrorMessage, settings } = useAppContext();
  const { exportTranscript, openOriginal } = useTranscriptActions();
  const [editing, setEditing] = useState(false);
  const [editWord, setEditWord] = useState<string | undefined>();
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingRetranscribe, setConfirmingRetranscribe] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreCancel = useRef<HTMLButtonElement>(null);
  const paragraphs = transcript.paragraphs?.length ? transcript.paragraphs : toParagraphs(transcript.text);
  const playback = useTranscriptPlayback(recordingId);
  // Flags come from the first transcription. Once the person has corrected the text, they have read it.
  const suspects = useMemo(() => new Set(transcript.editedAt ? [] : transcript.uncertainSegments ?? []), [transcript.editedAt, transcript.uncertainSegments]);
  const startEditing = (word?: string) => { setConfirmingRestore(false); setEditWord(word); setEditing(true); };
  /**
   * Text with flagged words underlined. Inside a sentence that plays, the word is only marked and described:
   * a second control there would answer the pointer but not the keyboard. Editing is one button away.
   */
  const marked = (text: string, insideControl = false) => splitSuspects(text, suspects).map((part, index) => !part.suspect ? part.text
    : insideControl
      ? <span key={index} className="suspect-word" aria-description={he.suspectWord}>{part.text}</span>
      : <span key={index} role="button" tabIndex={0} className="suspect-word" aria-description={he.suspectWord} title={he.suspectWordHint} data-hint={he.suspectWordHint}
        onClick={() => startEditing(part.text)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startEditing(part.text); } }}>{part.text}</span>);
  const cues = useMemo(() => getTranscriptCues(transcript), [transcript]);
  // With audio and timings the text reads as sentences, each one a way into the recording.
  const playable = playback.status === "ready" && cues.length > 0;
  const activeCue = playable && (playback.playing || playback.time > 0) ? cues.reduce((found, cue, index) => cue.start <= playback.time + 0.05 ? index : found, -1) : -1;
  const playCue = (start: number) => { if (window.getSelection()?.isCollapsed !== false) playback.playFrom(start); };
  const cueKey = (start: number) => (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    playback.playFrom(start);
  };
  useEffect(() => { if (confirmingRestore) restoreCancel.current?.focus(); }, [confirmingRestore]);

  const [suggestions, setSuggestions] = useState<OfferedSuggestion[]>([]);
  // Each pair is asked about once per transcript: a row that was dismissed or undone does not come back.
  const offered = useRef(new Set<string>());
  const finishEditing = (saved?: SavedEdit) => {
    const fresh = saved ? suggestDictionaryEntries(saved.before, saved.after, settings?.dictionary ?? [])
      .filter(item => !offered.current.has(item.heard)) : [];
    flushSync(() => {
      setEditing(false);
      if (fresh.length) setSuggestions(current => [...current, ...fresh.map(item => ({ ...item, state: "offered" as const }))].slice(-3));
    });
    fresh.forEach(item => offered.current.add(item.heard));
    editButton.current?.focus();
  };
  const focusEdit = useCallback(() => editButton.current?.focus(), []);
  const dismissRestore = () => {
    flushSync(() => setConfirmingRestore(false));
    editButton.current?.focus();
  };
  const restore = async () => {
    setRestoring(true);
    try {
      if (!await transcripts.restoreTranscript(transcript.id)) throw new Error("Transcript was not restored");
      dismissRestore();
    } catch {
      setErrorMessage("השחזור לא הושלם. אפשר לנסות שוב.");
    } finally {
      setRestoring(false);
    }
  };

  return <article className="transcript-channel">
    <header className="transcript-heading">
      <h3 dir="auto">{getTranscriptTitle(transcript)}</h3>
      <p className="transcript-meta">
        <span>{formatDate(transcript.createdAt)}</span>
        {transcript.durationMs ? <span className="tabular">{formatTranscriptDurationMs(transcript.durationMs)}</span> : null}
        <span>{countWords(transcript.text)}</span>
        {transcript.flowName ? <span dir="auto">{transcript.flowName}</span> : null}
        {transcript.editedAt ? <span>נערך</span> : null}
      </p>
      {onClose && !editing && <Button className="transcript-close" variant="ghost" size="icon-sm" aria-label="סגירת תמלול אחרון" onClick={onClose}><X /></Button>}
    </header>
    {editing ? <TranscriptEditor transcript={transcript} onDone={finishEditing} focusWord={editWord} /> : <>
      <div className="transcript-actions">
        <CopyButton text={transcript.text} />
        <Button ref={editButton} size="sm" variant="ghost" onClick={() => startEditing()}><Pencil />עריכה</Button>
        <Button size="sm" variant="ghost" aria-haspopup="menu" onClick={(event) => void exportTranscript(transcript.id, event.currentTarget)}><DownloadSimple />{he.exportMenu}</Button>
        {transcript.sourceUrl ? <Button size="sm" variant="ghost" onClick={() => void openOriginal(transcript.sourceUrl!)}><ArrowSquareOut />{he.openOriginal}</Button> : null}
        {transcript.editedAt || transcript.flowName ? <Button size="sm" variant="ghost" disabled={confirmingRestore} onClick={() => setConfirmingRestore(true)}><Restore />{transcript.flowName ? "חזרה להכתבה" : "שחזור המקור"}</Button> : null}
        {transcribeAgain ? <Button size="sm" variant="ghost" disabled={transcribeAgain.disabled || transcribeAgain.busy} focusableWhenDisabled
          onClick={() => transcript.editedAt ? setConfirmingRetranscribe(true) : transcribeAgain.run()}>
          <ArrowClockwise />{transcribeAgain.busy ? he.transcribing : he.retryTranscription}</Button> : null}
        {trailing && <span className="transcript-actions-end">{trailing}</span>}
      </div>
      {confirmingRetranscribe && transcribeAgain && <InlineConfirm title={he.retranscribeTitle} body={he.retranscribeBody} confirmLabel={he.retryTranscription}
        onConfirm={() => { setConfirmingRetranscribe(false); transcribeAgain.run(); }} onCancel={() => setConfirmingRetranscribe(false)} />}
      {confirmingRestore && <div className="inline-confirm" role="group" aria-label="שחזור המקור" aria-busy={restoring} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!restoring) dismissRestore(); } }}>
        <div className="inline-confirm-copy">{transcript.flowName
          ? <><strong>לחזור להכתבה כפי שנאמרה?</strong><p>{`התוצאה של "${transcript.flowName}"${transcript.editedAt ? " והעריכות בה" : ""} יימחקו מההיסטוריה. מה שכבר הודבק לא משתנה.`}</p></>
          : <><strong>לשחזר את התמלול המקורי?</strong><p>העריכות שנעשו בו יימחקו.</p></>}</div>
        <div className="inline-confirm-actions">
          <Button ref={restoreCancel} size="sm" variant="secondary" disabled={restoring} focusableWhenDisabled onClick={dismissRestore}>{he.reset}</Button>
          <Button size="sm" disabled={restoring} focusableWhenDisabled onClick={() => void restore()}>{restoring ? "משחזרים…" : "שחזור"}</Button>
        </div>
      </div>}
      <div className="transcript-content scroll-region" tabIndex={0} aria-label="טקסט התמלול" role="region">
        <div className="transcript-text select-text">{playable
          ? <p dir="auto">{cues.map((cue, index) => <Fragment key={index}>{index > 0 ? " " : null}
            <span role="button" tabIndex={0} className="transcript-cue" aria-current={index === activeCue ? "true" : undefined}
              onClick={() => playCue(cue.start)} onKeyDown={cueKey(cue.start)}>{marked(cue.text, true)}</span></Fragment>)}</p>
          : paragraphs.map((paragraph, index) => <p key={index} dir="auto">{marked(paragraph)}</p>)}</div>
      </div>
      {transcript.flowName && transcript.flowInput ? <details className="transcript-flow-input">
        <summary>ההכתבה כפי שנאמרה</summary>
        <p dir="auto" className="select-text">{transcript.flowInput}</p>
      </details> : null}
    </>}
    <DictionarySuggestions items={suggestions} onChange={setSuggestions} onEmptied={focusEdit} />
    {/* Last in both modes, so editing neither moves nor stops it. In History the text scrolls above it, so it stays at the bottom of the reader. */}
    <TranscriptPlayer playback={playback} />
  </article>;
}
