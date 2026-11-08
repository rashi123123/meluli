import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { formatShortcut, isGlobalShortcut, isReservedShortcut, toElectronAccelerator } from "@/lib/shortcut";
import { he } from "@shared/locale";
import { useKeepMainWindow } from "@/lib/keep-main-window";
import { getHebrewErrorMessage } from "@shared/error-utils";

export function ShortcutEditor({
  id,
  label,
  description,
  value,
  onSave
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // Escape stops listening without leaving the field; Enter, Space or a click listen again.
  const [paused, setPaused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  useKeepMainWindow(draft !== value || saving);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  useEffect(() => {
    setDraft(value);
    setSaveError(null);
  }, [value]);

  useEffect(() => { if (saveError) input.current?.focus(); }, [saveError]);

  return (
    <div className="shortcut-editor">
      <div className="settings-row-copy">
        <label className="settings-row-title" htmlFor={id}>{label}</label>
        <p id={descriptionId} className="settings-row-description">{focused && !paused ? he.shortcutEditHint : description}</p>
      </div>
      <Input
        id={id}
        ref={input}
        dir="ltr"
        value={formatShortcut(draft)}
        aria-describedby={saveError ? `${descriptionId} ${errorId}` : descriptionId}
        aria-invalid={Boolean(saveError)}
        aria-disabled={saving}
        aria-busy={saving}
        onKeyDown={(event) => {
          if (event.key === "Tab") return;
          if (savingRef.current) { event.preventDefault(); if (event.key === "Escape") event.stopPropagation(); return; }
          if (paused) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPaused(false); }
            else if (!event.metaKey) event.preventDefault();
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(value); setSaveError(null); setPaused(true); return; }
          event.preventDefault();
          const accelerator = toElectronAccelerator(event);
          if (accelerator && (!isGlobalShortcut(accelerator) || isReservedShortcut(accelerator))) {
            setDraft(value);
            setSaveError(isGlobalShortcut(accelerator) ? he.shortcutReserved : he.shortcutNeedsModifier);
          } else if (accelerator) {
            setDraft(accelerator);
            setSaveError(null);
          }
        }}
        onChange={() => {}}
        onPointerDown={() => setPaused(false)}
        onFocus={() => { setFocused(true); setPaused(false); }}
        onBlur={() => setFocused(false)}
      />
      {saveError && <p id={errorId} className="shortcut-error" role="alert">{saveError}</p>}
      {(draft !== value || saving) && <div className="shortcut-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { if (savingRef.current) return; setDraft(value); setSaveError(null); input.current?.focus(); }}
          aria-disabled={draft === value || saving}
        >
          {he.reset}
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            if (savingRef.current || draft === value) return;
            savingRef.current = true;
            setSaving(true);
            setSaveError(null);
            try {
              await onSave(draft);
              input.current?.focus();
            } catch (error) {
              setSaveError(getHebrewErrorMessage(error, he.shortcutSaveFailed));
            } finally {
              savingRef.current = false;
              setSaving(false);
            }
          }}
          aria-disabled={draft === value || saving}
          aria-busy={saving}
        >
          {he.save}
        </Button>
      </div>}
      <span className="sr-only" role="status">{saving ? he.shortcutSaving : ""}</span>
    </div>
  );
}
