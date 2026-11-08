import { Button } from "@/components/ui/button";
import { formatDate, formatTranscriptDurationMs } from "@/lib/format";
import { getTranscriptTitle } from "@shared/transcript-title";
import type { TranscriptRecord } from "@shared/types";

export function HistoryList({ items, selectedId, onSelect }: { items: TranscriptRecord[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <>{items.map((item) => <Button key={item.id} type="button" variant="plain" className="history-row" aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
    <span className="history-row-title" dir="auto">{getTranscriptTitle(item)}</span>
    <span className="history-row-meta">
      <span className="history-row-source">{formatDate(item.createdAt)}</span>
      {item.durationMs ? <span className="history-row-duration">{formatTranscriptDurationMs(item.durationMs)}</span> : null}
    </span>
  </Button>)}</>;
}
