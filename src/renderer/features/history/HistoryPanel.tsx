import { useEffect, useRef, useState } from "react";
import { Trash } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { LoadingMark } from "@/components/LoadingMark";
import { useAppContext } from "@/context/app-context";
import { he } from "@shared/locale";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { HistoryList } from "./HistoryList";

export function HistoryPanel() {
  const { transcripts, setErrorMessage } = useAppContext();
  const selectedTranscript = transcripts.selectedTranscript;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
    deletePending.current = true;
    setDeletingId(id);
    try {
      const deleted = await transcripts.deleteTranscript(id);
      if (!deleted) throw new Error("Transcript was not deleted");
      setConfirmId(current => current === id ? null : current);
      await transcripts.refresh();
      // A removed confirmation must not strand keyboard focus on the document.
      // Preserve a deliberate focus move made while the delete was pending.
      restoreListFocus.current = document.activeElement === document.body || Boolean(confirmation.current?.contains(document.activeElement));
    } catch {
      setErrorMessage("התמלול לא נמחק. אפשר לנסות שוב.");
    } finally {
      deletePending.current = false;
      setDeletingId(null);
    }
  };

  const emptyText = transcripts.items.length || transcripts.errorMessage ? ""
    : transcripts.isLoading ? he.loadingApp : transcripts.searchQuery.trim() ? "לא נמצאו תמלולים לחיפוש הזה." : he.historyEmpty;

  return <div className="history-page" aria-busy={transcripts.isLoading}>
    <div ref={historyBrowser} className="history-browser scroll-region" role="region" aria-label="רשימת התמלולים" tabIndex={-1}>
      {transcripts.errorMessage && <div role="alert">
        <p>{transcripts.errorMessage}</p>
        <Button variant="secondary" size="sm" disabled={transcripts.isLoading} focusableWhenDisabled onClick={() => void transcripts.refresh()}>{he.retry}</Button>
      </div>}
      {transcripts.items.length > 0 && <HistoryList items={transcripts.items} selectedId={transcripts.selectedId} onSelect={transcripts.setSelectedId} />}
      <div role="status" className={emptyText ? "history-empty empty-note empty-state" : "sr-only"}>{emptyText === he.loadingApp ? <LoadingMark /> : emptyText && <><EmptyMark kind={transcripts.searchQuery.trim() ? "search" : "history"} /><span>{emptyText}</span></>}</div>
      {transcripts.hasMore && <Button variant="secondary" size="sm" disabled={transcripts.isLoading} focusableWhenDisabled onClick={() => void transcripts.loadMore()}>{he.loadMore}</Button>}
    </div>
    <div className="history-reader">
      {selectedTranscript && confirmId === selectedTranscript.id && <div ref={confirmation} className="history-delete-confirmation inline-confirm" role="group" aria-label="מחיקת תמלול" aria-busy={Boolean(deletingId)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!deletingId) dismissConfirmation(); } }}>
        <div className="inline-confirm-copy"><strong>למחוק את התמלול?</strong><p>המחיקה קבועה ולא ניתן לבטל אותה.</p></div>
        <div className="inline-confirm-actions">
          <Button ref={cancelButton} size="sm" variant="secondary" disabled={Boolean(deletingId)} focusableWhenDisabled onClick={dismissConfirmation}>{he.reset}</Button>
          <Button size="sm" variant="destructive" disabled={Boolean(deletingId)} focusableWhenDisabled onClick={() => void handleDeleteSelected()}>{deletingId ? "מוחקים…" : "מחיקת התמלול"}</Button>
        </div>
      </div>}
      {selectedTranscript ? <TranscriptDocument key={selectedTranscript.id} transcript={selectedTranscript}
        trailing={<Button ref={deleteButton} variant="ghost" size="icon-sm" aria-label={he.delete} title={he.delete} disabled={Boolean(deletingId)} onClick={() => setConfirmId(selectedTranscript.id)}><Trash /></Button>} />
        : <p className="empty-note">{transcripts.items.length ? he.noTranscriptYet : ""}</p>}
    </div>
  </div>;
}
