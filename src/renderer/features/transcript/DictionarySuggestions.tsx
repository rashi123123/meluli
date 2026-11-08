import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context/app-context";
import { DICTIONARY_MAX_ENTRIES } from "@shared/constants";
import type { DictionarySuggestion } from "@shared/dictionary-suggestions";
import { he } from "@shared/locale";

export interface OfferedSuggestion extends DictionarySuggestion {
  state: "offered" | "busy" | "added" | "failed";
  entryId?: string;
}

/**
 * Quiet rows under a corrected transcript. The correction is already saved; these only teach the dictionary.
 * The region stays mounted so a screen reader hears each row once, politely.
 */
export function DictionarySuggestions({ items, onChange, onEmptied }: {
  items: OfferedSuggestion[];
  onChange: Dispatch<SetStateAction<OfferedSuggestion[]>>;
  /** Somewhere for focus to go when the last row it was on goes away. */
  onEmptied: () => void;
}) {
  const { settings, updateSetting } = useAppContext();
  const region = useRef<HTMLDivElement>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  // One dictionary write at a time: each one starts from the list the last one left, so two at once would drop a word.
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  const write = async (change: () => Promise<void>) => {
    if (writing.current) return;
    writing.current = true; setBusy(true);
    try { await change(); } finally { writing.current = false; setBusy(false); }
  };
  const set = (heard: string, patch: Partial<OfferedSuggestion> | null) =>
    onChange((current) => current.flatMap((item) => item.heard !== heard ? [item] : patch ? [{ ...item, ...patch }] : []));

  // A row that changes or leaves under the keyboard keeps focus nearby instead of dropping it on the page.
  useLayoutEffect(() => {
    if (focusRow === null) return;
    setFocusRow(null);
    const active = document.activeElement;
    if (active && active !== document.body && !region.current?.contains(active)) return;
    const rows = [...region.current?.querySelectorAll<HTMLElement>("[data-heard]") ?? []];
    const row = (rows.find((item) => item.dataset.heard === focusRow) ?? rows[0])?.querySelector("button");
    if (row) row.focus(); else onEmptied();
  }, [focusRow, onEmptied]);

  const add = (item: OfferedSuggestion) => write(async () => {
    const entries = settings?.dictionary ?? [];
    if (item.state === "busy") return;
    if (entries.length >= DICTIONARY_MAX_ENTRIES) return set(item.heard, { state: "failed" });
    const entryId = crypto.randomUUID();
    set(item.heard, { state: "busy" });
    try {
      await updateSetting("dictionary", [...entries, { id: entryId, heard: item.heard, written: item.written }]);
      set(item.heard, { state: "added", entryId });
    } catch {
      set(item.heard, { state: "failed" });
    }
    setFocusRow(item.heard);
  });

  const undo = (item: OfferedSuggestion) => write(async () => {
    try {
      await updateSetting("dictionary", (settings?.dictionary ?? []).filter((entry) => entry.id !== item.entryId));
      set(item.heard, null);
    } catch {
      set(item.heard, { state: "added" });
    }
    setFocusRow(item.heard);
  });

  const dismiss = (item: OfferedSuggestion) => { set(item.heard, null); setFocusRow(item.heard); };

  return <div ref={region} className="dictionary-suggestions" role="status">
    {items.map((item) => <div key={item.heard} data-heard={item.heard} className="dictionary-suggestion">
      <p>{item.state === "added" ? he.suggestionAdded
        : <>{he.suggestionAsk} "<bdi>{item.written}</bdi>" {he.suggestionInsteadOf} "<bdi>{item.heard}</bdi>"?</>}
        {item.state === "failed" ? <> <span className="dictionary-suggestion-error">{he.suggestionFailed}</span></> : null}</p>
      <span className="dictionary-suggestion-actions">
        {item.state === "added"
          ? <Button size="sm" variant="ghost" disabled={busy} focusableWhenDisabled onClick={() => void undo(item)}>{he.reset}</Button>
          : <>
            <Button size="sm" variant="secondary" disabled={busy} focusableWhenDisabled onClick={() => void add(item)}>{he.suggestionAdd}</Button>
            <Button size="sm" variant="ghost" disabled={item.state === "busy"} focusableWhenDisabled onClick={() => dismiss(item)}>{he.suggestionDismiss}</Button>
          </>}
      </span>
    </div>)}
  </div>;
}
