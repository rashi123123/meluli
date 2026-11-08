import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { he } from "@shared/locale";

/**
 * Asks once before something that cannot be undone. Cancel comes first and takes focus;
 * Escape cancels. While the action runs, both buttons stay put but do nothing.
 */
export function InlineConfirm({ title, body, confirmLabel, pendingLabel, onConfirm, onCancel }: {
  title: string; body?: string; confirmLabel: string; pendingLabel?: string; onConfirm: () => Promise<unknown> | void; onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { cancel.current?.focus(); }, []);
  const confirm = async () => {
    if (pending) return;
    setPending(true);
    try { await onConfirm(); } finally { setPending(false); }
  };
  return <div className="inline-confirm" role="group" aria-label={title} aria-busy={pending || undefined}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending) onCancel(); } }}>
    <div className="inline-confirm-copy"><strong>{title}</strong>{body && <p>{body}</p>}</div>
    <div className="inline-confirm-actions">
      <Button ref={cancel} size="sm" variant="secondary" aria-disabled={pending || undefined} onClick={() => { if (!pending) onCancel(); }}>{he.reset}</Button>
      <Button size="sm" variant="destructive" aria-disabled={pending || undefined} onClick={() => void confirm()}>{pending && pendingLabel ? pendingLabel : confirmLabel}</Button>
    </div>
  </div>;
}
