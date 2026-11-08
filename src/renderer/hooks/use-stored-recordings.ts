import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "@/context/app-context";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import type { StoredRecording } from "@shared/types";

/** Microphone recordings main keeps on disk: failed ones waiting, and kept ones beside their transcripts. */
export function useStoredRecordings() {
  const { transcripts, setErrorMessage } = useAppContext();
  const [recordings, setRecordings] = useState<StoredRecording[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);
  const api = window.ivritMenuBar.recordings;

  const refresh = useCallback(async () => {
    const next = await api?.list().catch(() => null);
    if (next && mounted.current) setRecordings(next);
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = api?.onChanged(() => { void refresh(); });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [api, refresh]);

  const failed = useMemo(() => recordings.filter((recording) => recording.status === "failed"), [recordings]);
  const byTranscript = useMemo(() => new Map(recordings.filter((recording) => recording.transcriptId)
    .map((recording) => [recording.transcriptId!, recording.id])), [recordings]);

  const transcribe = async (id: string) => {
    if (!api || busyId) return;
    setBusyId(id);
    try {
      const { transcript, replaced } = await api.transcribe(id);
      // A new transcript arrives through the completion event; a replaced one keeps its place.
      if (replaced && mounted.current) transcripts.replaceTranscript(transcript);
    } catch (error) {
      setErrorMessage(getHebrewErrorMessage(error, he.transcribeAgainFailed));
    } finally {
      if (mounted.current) setBusyId(null);
      void refresh();
    }
  };

  const discard = async (id: string) => {
    if (!api || busyId) return;
    try { await api.discard(id); }
    catch (error) { setErrorMessage(getHebrewErrorMessage(error, he.genericError)); }
    finally { void refresh(); }
  };

  return {
    failed,
    busyId,
    /** The kept recording behind this transcript, if its audio is still on disk. */
    recordingFor: (transcriptId: string) => byTranscript.get(transcriptId) ?? null,
    transcribe,
    discard
  };
}
