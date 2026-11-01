import { useCallback } from "react";
import { useAppContext } from "@/context/app-context";
import { getHebrewErrorMessage } from "@shared/error-utils";

// Renderer actions keep the existing validated preload capabilities and surface failures.
export function useTranscriptActions() {
  const { setErrorMessage } = useAppContext();
  const run = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, "הפעולה לא הושלמה. אפשר לנסות שוב.")); }
  }, [setErrorMessage]);
  return {
    exportSrt: (id: string) => run(() => window.ivritMenuBar.files.exportTranscriptSrt(id)),
    openOriginal: (url: string) => run(() => window.ivritMenuBar.files.openExternal(url))
  };
}
