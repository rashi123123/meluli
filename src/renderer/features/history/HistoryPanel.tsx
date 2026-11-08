import { useEffect, useRef, useState } from "react";
import { Trash, Warning } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { InlineConfirm } from "@/components/InlineConfirm";
import { LoadingMark } from "@/components/LoadingMark";
import { useAppContext } from "@/context/app-context";
import { he } from "@shared/locale";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { HistoryList } from "./HistoryList";
import { useStoredRecordings } from "@/hooks/use-stored-recordings";
import { formatDate, formatTranscriptDurationMs } from "@/lib/format";
import { getTranscriptTitle } from "@shared/transcript-title";

export function HistoryPanel() {
  const { transcripts, setErrorMessage, appState } = useAppContext();
  const recordings = useStoredRecordings();
  const jobRunning = appState.status !== "idle" && appState.status !== "error";
  const selectedTranscript = transcripts.selectedTranscript;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const deletePending = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const historyBrowser = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const restoreListFocus = useRef(false);
  useEffect(() => { setConfirmId(null); }, [selectedTranscript?.id]);
  useEffect(() => { if (confirmId) cancelButton.current?.focus(); }, [confirmId]);
  useEffect(() => {
    if (!restoreListFocus.current || deletingId || transcripts.isLoading) return;
    restoreListFocus.current = false;
    const selected = historyBrowser.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    const first = historyBrowser.current?.querySelector<HTMLButtonElement>("button[aria-pressed]");
    (selected ?? first ?? historyBrowser.current)?.focus();
  }, [deletingId, transcripts.isLoading, transcripts.selectedId]);
  const dismissConfirmation = () => {
    if (deletePending.current) return;
    setConfirmId(null);
    deleteButton.current?.focus();
  };

  const handleDeleteSelected = async () => {
    if (!selectedTranscript || confirmId !== selectedTranscript.id || deletePending.current) return;
    const id = selectedTranscript.id;
    // The next row down takes the deleted one's place, so working down a list keeps its spot.
    const index = transcripts.items.findIndex(item => item.id === id);
    const neighbour = transcripts.items[index + 1]?.id ?? transcripts.items[index - 1]?.id ?? null;
    deletePending.current = true;
    setDeletingId(id);
    try {
      const deleted = await transcripts.deleteTranscript(id);
      if (!deleted) throw new Error("Transcript was not deleted");
      setConfirmId(current => current === id ? null : current);
      transcripts.setSelectedId(neighbour);
      await transcripts.refresh();
      // A removed confirmation must not strand keyboard focus on the document.
      // Preserve a deliberate focus move made while the delete was pending.
      restoreListFocus.current = document.activeElement === document.body || Boolean(confirmation.current?.contains(document.activeElement));
    } catch {
      setErrorMessage(he.transcriptDeleteFailed);
    } finally {
      deletePending.current = false;
      setDeletingId(null);
    }
  };

  const emptyText = transcripts.items.length || transcripts.errorMessage ? ""
    : transcripts.isLoading ? he.loadingApp : transcripts.searchQuery.trim() ? he.searchNoResults(transcripts.searchQuery.trim()) : he.historyEmpty;

  return <div className="history-page" aria-busy={transcripts.isLoading}>
    <div ref={historyBrowser} className="history-browser scroll-region" role="region" aria-label="רשימת התמלולים" tabIndex={-1}>
      {transcripts.errorMessage && <div role="alert">
        <p>{transcripts.errorMessage}</p>
        <Button variant="secondary" size="sm" disabled={transcripts.isLoading} focusableWhenDisabled onClick={() => void transcripts.refresh()}>{he.retry}</Button>
      </div>}
      {recordings.failed.map((recording) => discardId === recording.id
        ? <InlineConfirm key={recording.id} title={he.unsentRecordingDeleteTitle} body={he.unsentRecordingDeleteBody} confirmLabel={he.unsentRecordingDeleteConfirm}
          onConfirm={async () => { await recordings.discard(recording.id); setDiscardId(null); }} onCancel={() => setDiscardId(null)} />
        : <section key={recording.id} className="workspace-setup-status" aria-label={he.unsentRecordingsTitle}>
        <Warning />
        <div className="workspace-setup-copy">
          <strong>{he.unsentRecordingsTitle}</strong>
          <p>{formatDate(recording.createdAt)} · {formatTranscriptDurationMs(recording.durationMs)} · {he.unsentRecordingsHint}</p>
        </div>
        <div className="workspace-setup-actions">
          <Button size="sm" variant="secondary" disabled={jobRunning || Boolean(recordings.busyId)} focusableWhenDisabled onClick={() => void recordings.transcribe(recording.id)}>
            {recordings.busyId === recording.id ? he.transcribing : he.unsentRecordingTranscribe}</Button>
          <Button size="sm" variant="ghost" disabled={Boolean(recordings.busyId)} focusableWhenDisabled onClick={() => setDiscardId(recording.id)}>{he.unsentRecordingDelete}</Button>
        </div>
      </section>)}
      {transcripts.items.length > 0 && <HistoryList items={transcripts.items} selectedId={transcripts.selectedId} onSelect={transcripts.setSelectedId} />}
      <div role="status" className={emptyText ? "history-empty empty-note empty-state" : "sr-only"}>{emptyText === he.loadingApp ? <LoadingMark /> : emptyText && <><EmptyMark kind={transcripts.searchQuery.trim() ? "search" : "history"} /><span>{emptyText}</span>
        {transcripts.searchQuery.trim() && <Button variant="ghost" size="sm" onClick={() => transcripts.setSearchQuery("")}>{he.searchClear}</Button>}</>}</div>
      {transcripts.hasMore && <Button variant="secondary" size="sm" disabled={transcripts.isLoading} focusableWhenDisabled onClick={() => void transcripts.loadMore()}>{he.loadMore}</Button>}
    </div>
    <div className="history-reader">
      {selectedTranscript && confirmId === selectedTranscript.id && <div ref={confirmation} className="history-delete-confirmation inline-confirm" role="group" aria-label="מחיקת תמלול" aria-busy={Boolean(deletingId)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!deletingId) dismissConfirmation(); } }}>
        <div className="inline-confirm-copy"><strong>{he.transcriptDeleteTitle(getTranscriptTitle(selectedTranscript))}</strong><p>{he.transcriptDeleteBody}</p></div>
        <div className="inline-confirm-actions">
          <Button ref={cancelButton} size="sm" variant="secondary" disabled={Boolean(deletingId)} focusableWhenDisabled onClick={dismissConfirmation}>{he.reset}</Button>
          <Button size="sm" variant="destructive" disabled={Boolean(deletingId)} focusableWhenDisabled onClick={() => void handleDeleteSelected()}>{deletingId ? he.transcriptDeleting : he.transcriptDeleteConfirm}</Button>
        </div>
      </div>}
      {selectedTranscript ? <TranscriptDocument key={selectedTranscript.id} transcript={selectedTranscript}
        recordingId={recordings.recordingFor(selectedTranscript.id)}
        transcribeAgain={(() => {
          const recordingId = recordings.recordingFor(selectedTranscript.id);
          return recordingId ? { busy: recordings.busyId === recordingId, disabled: jobRunning || Boolean(recordings.busyId), run: () => void recordings.transcribe(recordingId) } : undefined;
        })()}
        trailing={<Button ref={deleteButton} variant="ghost" size="icon-sm" aria-label={he.delete} title={he.delete} disabled={Boolean(deletingId)} onClick={() => setConfirmId(selectedTranscript.id)}><Trash /></Button>} />
        : <p className="empty-note">{transcripts.items.length ? he.noTranscriptYet : ""}</p>}
    </div>
  </div>;
}
