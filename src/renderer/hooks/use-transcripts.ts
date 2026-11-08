import { startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react";
import type { TranscriptEdit, TranscriptRecord } from "@shared/types";

interface UseTranscriptsOptions {
  /** Load and page the history list; the latest transcript always loads. */
  loadHistory?: boolean;
}

export function useTranscripts(options: UseTranscriptsOptions = {}) {
  const loadHistory = options.loadHistory ?? true;
  const [items, setItems] = useState<TranscriptRecord[]>([]);
  const [latestTranscript, setLatestTranscript] = useState<TranscriptRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery.trim());
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const latestRequest = useRef(0);
  const pagePending = useRef(false);
  const itemsRef = useRef<TranscriptRecord[]>([]);
  /** The search the loaded rows and their cursor came from; "" is the plain list. */
  const loadedQuery = useRef("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      historyRequest.current += 1;
      latestRequest.current += 1;
    };
  }, []);

  const replaceItems = (next: TranscriptRecord[]) => {
    itemsRef.current = next;
    setItems(next);
  };
  const invalidateRequests = () => {
    historyRequest.current += 1;
    latestRequest.current += 1;
    pagePending.current = false;
    setIsLoading(false);
  };

  const refreshLatestTranscript = useEffectEvent(async () => {
    if (!mounted.current) return;
    const request = ++latestRequest.current;
    try {
      const response = await window.ivritMenuBar.history.list(1, null);
      if (request === latestRequest.current) setLatestTranscript(response.items[0] ?? null);
    } catch {
      if (request === latestRequest.current && !loadHistory) {
        setErrorMessage("התמלולים לא נטענו. אפשר לנסות שוב.");
      }
    }
  });

  /** `keepLoaded` holds on to older rows already on screen, so a new transcript does not cut the list back to its first page. */
  const loadPage = useEffectEvent(async (append: boolean, keepLoaded = false) => {
    if (!mounted.current) return;
    if (!loadHistory) {
      setIsLoading(false);
      return;
    }
    // The cursor belongs to the rows on screen, so it cannot page through a different search.
    if (append && (pagePending.current || nextCursor === null || loadedQuery.current !== deferredSearch)) return;
    const request = ++historyRequest.current;
    pagePending.current = true;
    setErrorMessage(null);
    setIsLoading(true);
    try {
      const cursor = append ? nextCursor : null;
      const response = deferredSearch
        ? await window.ivritMenuBar.history.search(deferredSearch, 20, cursor)
        : await window.ivritMenuBar.history.list(20, cursor);

      if (request !== historyRequest.current) return;
      const oldest = response.items.at(-1);
      // Only rows past this page, which are older than its last one, are still known to belong in the list,
      // and only when they came from this same search.
      const kept = !append && keepLoaded && oldest && response.nextCursor !== null && loadedQuery.current === deferredSearch
        ? itemsRef.current.filter((item) => item.createdAt <= oldest.createdAt && !response.items.some((fresh) => fresh.id === item.id))
        : [];
      const merged = append ? [...itemsRef.current, ...response.items] : [...response.items, ...kept];
      const deduped = Array.from(new Map(merged.map((item) => [item.id, item])).values());
      replaceItems(deduped);
      loadedQuery.current = deferredSearch;
      // The kept rows end where the list already ended, so its cursor still stands.
      setNextCursor(kept.length ? nextCursor : response.nextCursor);
      setSelectedId((current) => deduped.some(item => item.id === current) ? current : deduped[0]?.id ?? null);
      if (!append && !deferredSearch) {
        latestRequest.current += 1;
        setLatestTranscript(response.items[0] ?? null);
      }
    } catch {
      if (request === historyRequest.current) setErrorMessage("התמלולים לא נטענו. אפשר לנסות שוב.");
    } finally {
      if (request === historyRequest.current) {
        pagePending.current = false;
        setIsLoading(false);
      }
    }
  });

  useEffect(() => {
    void refreshLatestTranscript();
    return () => { latestRequest.current += 1; };
  }, []);

  useEffect(() => {
    if (!loadHistory) {
      setIsLoading(false);
      return;
    }

    startTransition(() => {
      void loadPage(false);
    });
    return () => {
      historyRequest.current += 1;
      pagePending.current = false;
    };
    // `loadPage` is created via `useEffectEvent` and is stable across renders.
    // Including it in the dependency array can cause unnecessary re-runs in dev.
  }, [deferredSearch, loadHistory]);

  const prependTranscript = (transcript: TranscriptRecord, select = true) => {
    invalidateRequests();
    setErrorMessage(null);
    replaceItems([transcript, ...itemsRef.current.filter((item) => item.id !== transcript.id)]);
    setLatestTranscript(transcript);
    if (select) setSelectedId(transcript.id);
    // Reapply the current search and recover any older rows from a superseded load.
    if (loadHistory) void loadPage(false, true);
  };

  const replaceTranscript = (next: TranscriptRecord) => {
    const loadWasPending = pagePending.current;
    invalidateRequests();
    replaceItems(itemsRef.current.map((item) => (item.id === next.id ? next : item)));
    setLatestTranscript((current) => (current?.id === next.id ? next : current));
    // A superseded load may have been the one bringing the rest of the list.
    if (loadWasPending && loadHistory) void loadPage(false);
  };

  const updateTranscript = async (id: string, edit: TranscriptEdit) => {
    const next = await window.ivritMenuBar.history.update({ id, ...edit });
    if (next && mounted.current) replaceTranscript(next);
    return next;
  };

  const restoreTranscript = async (id: string) => {
    const next = await window.ivritMenuBar.history.restoreOriginal(id);
    if (next && mounted.current) replaceTranscript(next);
    return next;
  };

  const deleteTranscript = async (id: string) => {
    const deleted = await window.ivritMenuBar.history.delete(id);
    if (!deleted || !mounted.current) return deleted;

    invalidateRequests();
    replaceItems(itemsRef.current.filter((item) => item.id !== id));
    setSelectedId((current) => (current === id ? null : current));
    if (latestTranscript?.id === id) {
      await refreshLatestTranscript();
    }
    return true;
  };

  const deleteAllTranscripts = async () => {
    const deleted = await window.ivritMenuBar.history.deleteAll();
    if (!deleted) throw new Error("התמלולים לא נמחקו. אפשר לנסות שוב.");
    if (!mounted.current) return;
    invalidateRequests();
    replaceItems([]);
    setErrorMessage(null);
    setLatestTranscript(null);
    setSelectedId(null);
    setNextCursor(null);
  };

  return {
    latestTranscript,
    items,
    selectedId,
    selectedTranscript: items.find((item) => item.id === selectedId) ?? null,
    searchQuery,
    setSearchQuery,
    setSelectedId,
    prependTranscript,
    replaceTranscript,
    updateTranscript,
    restoreTranscript,
    deleteTranscript,
    deleteAllTranscripts,
    loadMore: () => (loadHistory ? loadPage(true) : Promise.resolve()),
    refresh: () => (loadHistory ? loadPage(false) : Promise.resolve()),
    hasMore: loadHistory && nextCursor !== null,
    isLoading,
    errorMessage
  };
}
