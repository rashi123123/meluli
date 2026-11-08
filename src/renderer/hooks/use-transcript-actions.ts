import { useCallback } from "react";
import { useAppContext } from "@/context/app-context";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";

// Renderer actions keep the existing validated preload capabilities and surface failures.
export function useTranscriptActions() {
  const { setErrorMessage } = useAppContext();
  const run = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.actionFailed)); }
  }, [setErrorMessage]);
  return {
    /** The native menu opens just below `trigger`. */
    exportTranscript: (id: string, trigger?: HTMLElement | null) => run(() => {
      const box = trigger?.getBoundingClientRect();
      return window.ivritMenuBar.files.exportTranscript(id, box ? { x: Math.max(0, Math.round(box.left)), y: Math.max(0, Math.round(box.bottom + 4)) } : undefined);
    }),
    openOriginal: (url: string) => run(() => window.ivritMenuBar.files.openExternal(url))
  };
}
