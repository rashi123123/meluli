import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { CopyButton } from "@/components/CopyButton";
import { ArrowSquareOut, DownloadSimple, Pencil, Restore, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { useTranscriptActions } from "@/hooks/use-transcript-actions";
import { formatDate, formatTranscriptDurationMs } from "@/lib/format";
import { getTranscriptTitle } from "@/lib/transcript-source";
import { he } from "@shared/locale";
import type { TranscriptRecord } from "@shared/types";
import { TranscriptEditor } from "./TranscriptEditor";

const toParagraphs = (text: string) => text.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean);
const countWords = (text: string) => {
  const count = text.trim().split(/\s+/).filter(Boolean).length;
  return count === 1 ? "מילה אחת" : `${count} מילים`;
};

/** One transcript, read or edited in place. Render with key={transcript.id}. */
export function TranscriptDocument({ transcript, trailing, onClose }: { transcript: TranscriptRecord; trailing?: ReactNode; onClose?: () => void }) {
  const { transcripts, setErrorMessage } = useAppContext();
  const { exportSrt, openOriginal } = useTranscriptActions();
  const [editing, setEditing] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreCancel = useRef<HTMLButtonElement>(null);
  const paragraphs = transcript.paragraphs?.length ? transcript.paragraphs : toParagraphs(transcript.text);
  useEffect(() => { if (confirmingRestore) restoreCancel.current?.focus(); }, [confirmingRestore]);

  const finishEditing = () => {
    flushSync(() => setEditing(false));
    editButton.current?.focus();
  };
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
        {transcript.editedAt ? <span>נערך</span> : null}
      </p>
      {onClose && !editing && <Button className="transcript-close" variant="ghost" size="icon-sm" aria-label="סגירת תמלול אחרון" onClick={onClose}><X /></Button>}
    </header>
    {editing ? <TranscriptEditor transcript={transcript} onDone={finishEditing} /> : <>
      <div className="transcript-actions">
        <CopyButton text={transcript.text} />
        <Button ref={editButton} size="sm" variant="secondary" onClick={() => { setConfirmingRestore(false); setEditing(true); }}><Pencil />עריכה</Button>
        {transcript.segments?.length ? <Button size="sm" variant="ghost" onClick={() => void exportSrt(transcript.id)}><DownloadSimple />{he.downloadSrt}</Button> : null}
        {transcript.sourceUrl ? <Button size="sm" variant="ghost" onClick={() => void openOriginal(transcript.sourceUrl!)}><ArrowSquareOut />{he.openOriginal}</Button> : null}
        {transcript.editedAt ? <Button size="sm" variant="ghost" disabled={confirmingRestore} onClick={() => setConfirmingRestore(true)}><Restore />שחזור המקור</Button> : null}
        {trailing && <span className="transcript-actions-end">{trailing}</span>}
      </div>
      {confirmingRestore && <div className="inline-confirm" role="group" aria-label="שחזור המקור" aria-busy={restoring} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!restoring) dismissRestore(); } }}>
        <div className="inline-confirm-copy"><strong>לשחזר את התמלול המקורי?</strong><p>העריכות שנעשו בו יימחקו.</p></div>
        <div className="inline-confirm-actions">
          <Button ref={restoreCancel} size="sm" variant="secondary" disabled={restoring} focusableWhenDisabled onClick={dismissRestore}>{he.reset}</Button>
          <Button size="sm" disabled={restoring} focusableWhenDisabled onClick={() => void restore()}>{restoring ? "משחזרים…" : "שחזור"}</Button>
        </div>
      </div>}
      <div className="transcript-content scroll-region" tabIndex={0} aria-label="טקסט התמלול" role="region">
        <div className="transcript-text select-text">{paragraphs.map((paragraph, index) => <p key={index} dir="auto">{paragraph}</p>)}</div>
      </div>
    </>}
  </article>;
}
