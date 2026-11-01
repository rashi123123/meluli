import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "@/components/icons";
import { Button } from "./ui/button";
import { he } from "@shared/locale";

export function CopyButton({ text, emphasized = false, iconOnly = false }: {
  text: string; emphasized?: boolean; iconOnly?: boolean;
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
  return <>
    <span className="sr-only" role="status">{copied || failed ? label : ""}</span>
    <Button variant={emphasized ? "default" : "secondary"} size={iconOnly ? "icon-sm" : "sm"}
    aria-label={label} title={label} disabled={!text}
    onClick={async () => {
      const current = ++operation.current;
      window.clearTimeout(timer.current);
      try {
        await window.ivritMenuBar.clipboard.writeText(text);
        if (operation.current !== current) return;
        setFailed(false); setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      } catch {
        if (operation.current === current) { setCopied(false); setFailed(true); }
      }
    }}>
    {copied ? <Check /> : <Copy />}
    {!iconOnly ? label : null}
    </Button>
  </>;
}
