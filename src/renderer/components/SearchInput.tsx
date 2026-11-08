import { useRef } from "react";
import { MagnifyingGlass, X } from "@/components/icons";
import { he } from "@shared/locale";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * `shortcut` shows the key that reaches this field from anywhere, like "⌘F".
 * It sits where the clear button goes, so it gives way once there is text to clear.
 */
export function SearchInput({ value, onChange, placeholder, inputId, ariaLabel, shortcut, keyShortcuts }: {
  value: string; onChange: (value: string) => void; placeholder: string; inputId?: string; ariaLabel?: string;
  shortcut?: string; keyShortcuts?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="search-field">
    <MagnifyingGlass />
    <Input ref={input} id={inputId} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={ariaLabel ?? placeholder} aria-keyshortcuts={keyShortcuts}
      onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); event.stopPropagation(); onChange(""); } }} />
    {value.trim().length > 0 && <Button type="button" variant="ghost" size="icon-xs" data-motion="instant" onClick={() => { onChange(""); input.current?.focus(); }} aria-label={he.clearSearch}><X /></Button>}
    {shortcut && value.trim().length === 0 && <kbd className="search-shortcut" dir="ltr" aria-hidden="true">{shortcut}</kbd>}
  </div>;
}
