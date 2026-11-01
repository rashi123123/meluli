import { useLayoutEffect, useRef, useState } from "react";
import { X } from "./icons";
import { Button } from "./ui/button";

const MAX_NOTICES = 4;

/** Newer messages stack over older ones instead of replacing them. */
export function NoticeToast({ message, onDismiss, urgent = false }: { message: string; onDismiss: () => void; urgent?: boolean }) {
  const [notices, setNotices] = useState<Array<{ id: number; text: string }>>([]);
  const nextId = useRef(0);
  const previous = useRef("");
  useLayoutEffect(() => {
    const cleared = previous.current;
    previous.current = message;
    setNotices(current => {
      // Cleared by its owner, so the problem is over. A replaced message still stands.
      const kept = message ? current : current.filter(notice => notice.text !== cleared);
      if (!message || kept.some(notice => notice.text === message)) return kept;
      return [...kept, { id: nextId.current++, text: message }].slice(-MAX_NOTICES);
    });
  }, [message]);
  const dismiss = (notice: { id: number; text: string }) => {
    document.getElementById("main-content")?.focus();
    setNotices(current => current.filter(item => item.id !== notice.id));
    if (notice.text === message) onDismiss();
  };
  return <>
    <span className="sr-only" role={urgent ? "alert" : "status"} aria-live={urgent ? "assertive" : "polite"} aria-atomic="true">{message}</span>
    <div className="notice-stack">
      {notices.map(notice => <div key={notice.id} className="notice-toast">
        <span>{notice.text}</span>
        <Button size="icon-sm" variant="ghost" aria-label="סגירת הודעה" onClick={() => dismiss(notice)}><X /></Button>
      </div>)}
    </div>
  </>;
}
