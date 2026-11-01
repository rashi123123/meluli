import { EmptyMark } from "@/components/EmptyMark";
import { Trash } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DICTIONARY_MAX_ENTRIES, DICTIONARY_MAX_LENGTH } from "@shared/constants";
import { he } from "@shared/locale";
import type { DictionaryEntry } from "@shared/types";
import { useId, useState, type FormEvent } from "react";

const comparable = (value: string) => value.trim().toLowerCase();

export function DictionarySection({ entries, busy, onChange }: {
  entries: DictionaryEntry[];
  busy: boolean;
  onChange: (next: DictionaryEntry[]) => void;
}) {
  const [heard, setHeard] = useState("");
  const [written, setWritten] = useState("");
  const heardId = useId();
  const writtenId = useId();

  const duplicate = entries.some((entry) => comparable(entry.heard) === comparable(heard));
  const full = entries.length >= DICTIONARY_MAX_ENTRIES;
  const message = duplicate ? he.dictionaryDuplicate : full ? he.dictionaryFull : null;
  const canAdd = !busy && !duplicate && !full && heard.trim() !== "" && written.trim() !== "";

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;
    onChange([...entries, { id: crypto.randomUUID(), heard: heard.trim(), written: written.trim() }]);
    setHeard("");
    setWritten("");
  };

  return <div className="dictionary">
    <form className="dictionary-form" onSubmit={add}>
      <label htmlFor={heardId}>{he.dictionaryHeard}</label>
      <label htmlFor={writtenId}>{he.dictionaryWritten}</label>
      <Input id={heardId} dir="auto" value={heard} maxLength={DICTIONARY_MAX_LENGTH} autoComplete="off" spellCheck={false}
        onChange={(event) => setHeard(event.target.value)} />
      <Input id={writtenId} dir="auto" value={written} maxLength={DICTIONARY_MAX_LENGTH} autoComplete="off" spellCheck={false}
        onChange={(event) => setWritten(event.target.value)} />
      <Button type="submit" size="sm" variant="secondary" disabled={!canAdd} focusableWhenDisabled>{he.dictionaryAdd}</Button>
    </form>
    {message && <p className="dictionary-message" role="status">{message}</p>}
    {entries.length === 0 && <div className="empty-note empty-state"><EmptyMark kind="dictionary" /><span>{he.dictionaryEmpty}</span></div>}
    {entries.length > 0 && <ul className="dictionary-list" aria-label={he.dictionaryPersonal}>
      {entries.map((entry) => <li key={entry.id}>
        <span dir="auto">{entry.heard}</span>
        <span dir="auto">{entry.written}</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`${he.delete} ${entry.heard}`} title={he.delete} disabled={busy} focusableWhenDisabled
          onClick={() => onChange(entries.filter((candidate) => candidate.id !== entry.id))}><Trash /></Button>
      </li>)}
    </ul>}
  </div>;
}
