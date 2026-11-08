import { EmptyMark } from "@/components/EmptyMark";
import { Trash } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DICTIONARY_MAX_ENTRIES, DICTIONARY_MAX_LENGTH } from "@shared/constants";
import { he } from "@shared/locale";
import type { DictionaryEntry } from "@shared/types";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useKeepMainWindow } from "@/lib/keep-main-window";

const comparable = (value: string) => value.trim().toLowerCase();

export function DictionarySection({ entries, busy, onChange }: {
  entries: DictionaryEntry[];
  busy: boolean;
  onChange: (next: DictionaryEntry[]) => void;
}) {
  const [heard, setHeard] = useState("");
  const [written, setWritten] = useState("");
  useKeepMainWindow(Boolean(heard.trim() || written.trim()));
  const heardId = useId();
  const writtenId = useId();
  const messageId = useId();
  const heardInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // The typed pair stays until the saved list holds it, so a failed save does not throw it away.
  const [savingId, setSavingId] = useState<string | null>(null);
  const saved = savingId !== null && entries.some((entry) => entry.id === savingId);
  useLayoutEffect(() => {
    if (!saved) return;
    setSavingId(null);
    setHeard("");
    setWritten("");
    heardInput.current?.focus();
  }, [saved]);

  const duplicate = !saved && entries.some((entry) => comparable(entry.heard) === comparable(heard));
  const full = entries.length >= DICTIONARY_MAX_ENTRIES;
  const message = duplicate ? he.dictionaryDuplicate : full ? he.dictionaryFull : null;
  const canAdd = !busy && !duplicate && !full && heard.trim() !== "" && written.trim() !== "";

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    const id = crypto.randomUUID();
    setSavingId(id);
    onChange([...entries, { id, heard: heard.trim(), written: written.trim() }]);
  };

  const remove = (index: number) => {
    const next = entries.filter((_, candidate) => candidate !== index);
    onChange(next);
    // Focus the row that moves into this place, or the form when the list empties.
    requestAnimationFrame(() => {
      const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button");
      const target = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];
      (target ?? heardInput.current)?.focus();
    });
  };

  return <div className="dictionary">
    <form className="dictionary-form" onSubmit={add}>
      <label htmlFor={heardId}>{he.dictionaryHeard}</label>
      <label htmlFor={writtenId}>{he.dictionaryWritten}</label>
      <Input ref={heardInput} id={heardId} dir="auto" value={heard} aria-invalid={duplicate || undefined} aria-describedby={message ? messageId : undefined} maxLength={DICTIONARY_MAX_LENGTH} autoComplete="off" spellCheck={false}
        onChange={(event) => { setSavingId(null); setHeard(event.target.value); }} />
      <Input id={writtenId} dir="auto" value={written} maxLength={DICTIONARY_MAX_LENGTH} autoComplete="off" spellCheck={false}
        onChange={(event) => { setSavingId(null); setWritten(event.target.value); }} />
      <Button type="submit" size="sm" variant="secondary" disabled={!canAdd} focusableWhenDisabled>{he.dictionaryAdd}</Button>
    </form>
    {message && <p id={messageId} className="dictionary-message" role="status">{message}</p>}
    {entries.length === 0 && <div className="empty-note empty-state"><EmptyMark kind="dictionary" /><span>{he.dictionaryEmpty}</span></div>}
    {entries.length > 0 && <ul ref={list} className="dictionary-list" aria-label={he.dictionaryPersonal}>
      {entries.map((entry, index) => <li key={entry.id}>
        <span dir="auto">{entry.heard}</span>
        <span dir="auto">{entry.written}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`${he.delete} ${entry.heard}`} title={he.delete} disabled={busy} focusableWhenDisabled
          onClick={() => remove(index)}><Trash /></Button>
      </li>)}
    </ul>}
  </div>;
}
