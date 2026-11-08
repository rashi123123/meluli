import { useEffect, useRef, useState } from "react";
import { Check, Copy, Warning } from "@/components/icons";
import { Button } from "./ui/button";
import { he } from "@shared/locale";

/** How long the button says it copied. */
const COPIED_SHOWN_MS = 1600;

export function CopyButton({ text, emphasized = false, iconOnly = false, primary = false }: {
  text: string; emphasized?: boolean; iconOnly?: boolean; primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const operation = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    operation.current++;
    setCopied(false); setFailed(false);
    return () => { operation.current++; window.clearTimeout(timer.current); };
  }, [text]);
  const label = failed ? "ההעתקה לא הצליחה. ניסיון נוסף" : copied ? he.copied : he.copy;
  const visible = failed ? "ניסיון נוסף" : label;
  return <>
    <span className="sr-only" role="status">{copied || failed ? label : ""}</span>
    <Button variant={emphasized ? "default" : "secondary"} size={iconOnly ? "icon-sm" : "sm"}
    aria-label={label} title={label} disabled={!text} data-hud-primary={primary ? "" : undefined} data-copy-state={failed ? "failed" : copied ? "copied" : undefined}
    onClick={async () => {
      const current = ++operation.current;
      window.clearTimeout(timer.current);
      try {
        await window.ivritMenuBar.clipboard.writeText(text);
        if (operation.current !== current) return;
        setFailed(false); setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_SHOWN_MS);
      } catch {
        if (operation.current === current) { setCopied(false); setFailed(true); }
      }
    }}>
    {failed ? <Warning /> : copied ? <Check /> : <Copy />}
    {!iconOnly ? visible : null}
    </Button>
  </>;
}
