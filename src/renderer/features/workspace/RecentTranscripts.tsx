import { useAppContext } from "@/context/app-context";
import { FolderOpen, LinkSimple, Microphone, Phone } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { LoadingMark } from "@/components/LoadingMark";
import { formatDate, formatDay, formatTime, formatTranscriptDurationMs } from "@/lib/format";
import { getTranscriptSourceKindLabel } from "@/lib/transcript-source";
import { getTranscriptTitle } from "@shared/transcript-title";
import { he } from "@shared/locale";
import type { TranscriptRecord } from "@shared/types";

const groupByDay = (items: TranscriptRecord[]) => {
  const days = new Map<string, TranscriptRecord[]>();
  for (const item of items) {
    const day = formatDay(item.createdAt);
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return [...days];
};

/** `excludeId` leaves out the transcript already open in full above the list. */
export function RecentTranscripts({ excludeId }: { excludeId?: string }) {
  const { transcripts, setActiveView } = useAppContext();
  const visibleItems = transcripts.items.filter(item => item.id !== excludeId).slice(0, 8);
  const emptyText = visibleItems.length || transcripts.errorMessage || excludeId ? ""
    : transcripts.isLoading ? he.loadingApp : "התמלולים שלך יופיעו כאן. אפשר להתחיל מהקלטה, מקובץ או מקישור.";
  return <section className="recent-transcripts" aria-labelledby="recent-title" aria-busy={transcripts.isLoading}>
    <header className="section-heading"><h3 id="recent-title">תמלולים אחרונים</h3>{visibleItems.length > 0 && <Button variant="ghost" size="sm" onClick={() => setActiveView("history")}>{he.allTranscripts}</Button>}</header>
    {transcripts.errorMessage && <div role="alert">
      <p>{transcripts.errorMessage}</p><Button variant="secondary" size="sm" disabled={transcripts.isLoading} focusableWhenDisabled onClick={() => void transcripts.refresh()}>{he.retry}</Button>
    </div>}
    {visibleItems.length > 0 && groupByDay(visibleItems).map(([day, items]) => <div key={day}>
      <p className="day-label">{day}</p>
      {items.map(item => {
        const Icon = item.sourceType === "youtube" ? LinkSimple : item.sourceType === "imported_file" ? FolderOpen : item.sourceType === "call" ? Phone : Microphone;
        const title = getTranscriptTitle(item);
        return <Button key={item.id} variant="plain" className="transcript-preview" aria-label={`${title}, ${getTranscriptSourceKindLabel(item)}${item.durationMs ? `, ${formatTranscriptDurationMs(item.durationMs)}` : ""}, ${formatDate(item.createdAt)}`} onClick={() => { transcripts.setSelectedId(item.id); setActiveView("history"); }}>
          <Icon />
          <span className="preview-title" dir="auto">{title}</span>
          <span className="preview-number preview-duration">{item.durationMs ? formatTranscriptDurationMs(item.durationMs) : ""}</span>
          <span className="preview-number">{formatTime(item.createdAt)}</span>
        </Button>;
      })}
    </div>)}
    <div role="status" className={emptyText ? "history-empty empty-note empty-state" : "sr-only"}>{emptyText === he.loadingApp ? <LoadingMark /> : emptyText && <><EmptyMark kind="history" /><span>{emptyText}</span></>}</div>
  </section>;
}
