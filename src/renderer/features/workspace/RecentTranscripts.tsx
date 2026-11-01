import { useAppContext } from "@/context/app-context";
import { FolderOpen, LinkSimple, Microphone, Phone } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { LoadingMark } from "@/components/LoadingMark";
import { formatDate, formatDay, formatTime, formatTranscriptDurationMs } from "@/lib/format";
import { getTranscriptSourceKindLabel, getTranscriptTitle } from "@/lib/transcript-source";
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

export function RecentTranscripts() {
  const { transcripts, setActiveView } = useAppContext();
  const searching = Boolean(transcripts.searchQuery.trim());
  const visibleItems = transcripts.items.slice(0, 8);
  const emptyText = visibleItems.length || transcripts.errorMessage ? ""
    : transcripts.isLoading ? he.loadingApp : searching ? "לא נמצאו תמלולים לחיפוש הזה." : "התמלולים שלך יופיעו כאן. אפשר להתחיל מהקלטה או מקובץ.";
  return <section className="recent-transcripts" aria-labelledby="recent-title" aria-busy={transcripts.isLoading}>
    <header className="section-heading"><h3 id="recent-title">{searching ? "תוצאות חיפוש" : "תמלולים אחרונים"}</h3><Button variant="ghost" size="sm" aria-label="לכל התמלולים" onClick={() => setActiveView("history")}>הכול</Button></header>
    {transcripts.errorMessage && <div role="alert">
      <p>{transcripts.errorMessage}</p><Button variant="secondary" size="sm" disabled={transcripts.isLoading} focusableWhenDisabled onClick={() => void transcripts.refresh()}>{he.retry}</Button>
    </div>}
    {visibleItems.length > 0 && groupByDay(visibleItems).map(([day, items]) => <div key={day}>
      <p className="day-label">{day}</p>
      {items.map(item => {
        const Icon = item.sourceType === "youtube" ? LinkSimple : item.sourceType === "imported_file" ? FolderOpen : item.sourceType === "call" ? Phone : Microphone;
        const title = getTranscriptTitle(item);
        return <Button key={item.id} variant="plain" className="transcript-preview" aria-label={`פתיחת ${title}, ${formatDate(item.createdAt)}`} onClick={() => { transcripts.setSelectedId(item.id); setActiveView("history"); }}>
          <Icon />
          <span className="preview-title" dir="auto">{title}</span>
          <span className="preview-source">{getTranscriptSourceKindLabel(item)}</span>
          <span className="preview-number preview-duration">{item.durationMs ? formatTranscriptDurationMs(item.durationMs) : ""}</span>
          <span className="preview-number">{formatTime(item.createdAt)}</span>
        </Button>;
      })}
    </div>)}
    <div role="status" className={emptyText ? "history-empty empty-note empty-state" : "sr-only"}>{emptyText === he.loadingApp ? <LoadingMark /> : emptyText && <><EmptyMark kind={searching ? "search" : "history"} /><span>{emptyText}</span></>}</div>
  </section>;
}
