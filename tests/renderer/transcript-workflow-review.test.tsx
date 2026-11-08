import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "@/context/app-context";
import { useTranscripts } from "@/hooks/use-transcripts";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { YouTubeInputRow } from "@/features/workspace/YouTubeInputRow";
import { RecentTranscripts } from "@/features/workspace/RecentTranscripts";
import { he } from "@shared/locale";
import type { TranscriptRecord } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Page = { items: TranscriptRecord[]; nextCursor: number | null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const record = (id: string): TranscriptRecord => ({ id, text: `תמלול ${id}`, createdAt: 1000, sourceType: "microphone" });
const page = (...items: TranscriptRecord[]): Page => ({ items, nextCursor: null });
let host: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useTranscripts>;
let context: AppContextValue;
const history = { list: vi.fn(), search: vi.fn(), delete: vi.fn(), deleteAll: vi.fn() };
function Harness({ loadHistory = true }) {
  current = useTranscripts({ loadHistory });
  return null;
}
async function render(node: ReactNode) { await act(async () => root.render(node)); }
async function renderContext(node: ReactNode) { await render(<AppContext.Provider value={context}>{node}</AppContext.Provider>); }
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.getAttribute("aria-label") === text)!; }
async function typeUrl(value: string) {
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  history.list.mockReset().mockResolvedValue(page()); history.search.mockReset().mockResolvedValue(page());
  history.delete.mockReset().mockResolvedValue(true); history.deleteAll.mockReset().mockResolvedValue(true);
  Object.assign(window, { ivritMenuBar: { history, files: { exportTranscript: vi.fn(), openExternal: vi.fn() }, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } } });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  // These components use only transcript, source-action and YouTube capabilities.
  context = {
    settings: { modelState: { downloadState: "ready" } },
    appState: { status: "idle", timerStartedAt: null }, setErrorMessage: vi.fn(), setActiveView: vi.fn(),
    submitYouTubeUrl: vi.fn(), cancelPendingYouTube: vi.fn(),
    transcripts: { items: [record("a")], latestTranscript: record("a"), selectedId: "a", selectedTranscript: record("a"), searchQuery: "", setSearchQuery: vi.fn(), setSelectedId: vi.fn(), prependTranscript: vi.fn(), deleteTranscript: vi.fn().mockResolvedValue(true), deleteAllTranscripts: vi.fn(), refresh: vi.fn(), loadMore: vi.fn(), isLoading: false, hasMore: false }
  } as unknown as AppContextValue;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("transcript request ordering", () => {
  it("ignores an older search response without clearing the current loading state", async () => {
    const first = deferred<Page>(); const second = deferred<Page>();
    history.search.mockImplementation((query: string) => query === "א" ? first.promise : second.promise);
    await render(<Harness />);
    await act(async () => current.setSearchQuery("א"));
    await act(async () => current.setSearchQuery("ב"));
    await act(async () => first.resolve(page(record("old"))));
    expect(current.items).toEqual([]); expect(current.isLoading).toBe(true);
    await act(async () => second.resolve(page(record("new"))));
    expect(current.items.map(item => item.id)).toEqual(["new"]);
    expect(current.selectedTranscript?.id).toBe("new"); expect(current.isLoading).toBe(false);
  });

  it("selects a result when the previously selected id is absent from a new search", async () => {
    history.list.mockResolvedValue(page(record("a"), record("b")));
    history.search.mockResolvedValue(page(record("c")));
    await render(<Harness />); await act(async () => current.setSelectedId("b"));
    await act(async () => current.setSearchQuery("  אחר  "));
    expect(history.search).toHaveBeenCalledWith("אחר", 20, null);
    expect(current.selectedTranscript?.id).toBe("c");
  });

  it("exposes a failed load and clears the error after a successful retry", async () => {
    history.list.mockResolvedValueOnce(page()); // the latest-transcript request goes first
    history.list.mockRejectedValueOnce(new Error("Database unavailable"));
    await render(<Harness />);
    expect(current.errorMessage).toContain("לא נטענו"); expect(current.isLoading).toBe(false);
    history.list.mockResolvedValue(page(record("retry")));
    await act(async () => current.refresh());
    expect(current.errorMessage).toBeNull(); expect(current.items[0].id).toBe("retry");
  });

  it("keeps a new transcript when older latest/page requests finish after its event", async () => {
    const staleLatest = deferred<Page>(); const stalePage = deferred<Page>(); const freshPage = deferred<Page>();
    history.list.mockImplementationOnce(() => staleLatest.promise).mockImplementationOnce(() => stalePage.promise).mockImplementationOnce(() => freshPage.promise);
    await render(<Harness />);
    await act(async () => current.prependTranscript(record("new")));
    await act(async () => { staleLatest.resolve(page(record("old"))); stalePage.resolve(page(record("old"))); });
    expect(current.latestTranscript?.id).toBe("new"); expect(current.items[0].id).toBe("new"); expect(current.isLoading).toBe(true);
    await act(async () => freshPage.resolve(page(record("new"), record("old"))));
    expect(current.items.map(item => item.id)).toEqual(["new", "old"]);
  });

  it("dispatches only one pending pagination request and deduplicates its boundary item", async () => {
    history.list.mockResolvedValueOnce(page()); // the latest-transcript request goes first
    history.list.mockResolvedValueOnce({ items: [record("a")], nextCursor: 100 });
    await render(<Harness />);
    const next = deferred<Page>(); history.list.mockReturnValueOnce(next.promise);
    await act(async () => { void current.loadMore(); void current.loadMore(); });
    expect(history.list).toHaveBeenCalledTimes(3); // latest, first page, one next page
    await act(async () => next.resolve(page(record("a"), record("b"))));
    expect(current.items.map(item => item.id)).toEqual(["a", "b"]); expect(current.hasMore).toBe(false);
  });

  it("discards a page response after history loading is disabled", async () => {
    const pending = deferred<Page>(); history.list.mockReturnValueOnce(pending.promise);
    await render(<Harness />); await render(<Harness loadHistory={false} />);
    await act(async () => pending.resolve(page(record("stale"))));
    expect(current.items).toEqual([]); expect(current.isLoading).toBe(false);
  });

  it("does not resurrect a deleted record from a previously pending page", async () => {
    history.list.mockResolvedValueOnce(page()); // the latest-transcript request goes first
    history.list.mockResolvedValueOnce(page(record("a"), record("b")));
    await render(<Harness />);
    const stale = deferred<Page>(); history.list.mockReturnValueOnce(stale.promise);
    await act(async () => { void current.refresh(); });
    await act(async () => current.deleteTranscript("a"));
    await act(async () => stale.resolve(page(record("a"), record("b"))));
    expect(current.items.map(item => item.id)).toEqual(["b"]);
  });

  it("keeps older loaded rows and the chosen row when a new transcript arrives", async () => {
    const at = (id: string, createdAt: number) => ({ ...record(id), createdAt });
    history.list.mockResolvedValueOnce(page()); // the latest-transcript request goes first
    history.list.mockResolvedValueOnce({ items: [at("b", 300), at("c", 200)], nextCursor: 200 });
    await render(<Harness />);
    history.list.mockResolvedValueOnce({ items: [at("d", 100)], nextCursor: null });
    await act(async () => current.loadMore());
    await act(async () => current.setSelectedId("d"));
    history.list.mockResolvedValueOnce({ items: [at("a", 400), at("b", 300)], nextCursor: 300 });
    await act(async () => current.prependTranscript(at("a", 400), false));
    expect(current.items.map(item => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(current.selectedTranscript?.id).toBe("d"); expect(current.hasMore).toBe(false);
  });

  it("keeps no rows or cursor from another search when a new transcript arrives mid-search", async () => {
    const at = (id: string, createdAt: number) => ({ ...record(id), createdAt });
    history.list.mockResolvedValueOnce(page()); // the latest-transcript request goes first
    history.list.mockResolvedValueOnce({ items: [at("b", 300), at("c", 200)], nextCursor: 200 });
    await render(<Harness />);
    const pending = deferred<Page>(); history.search.mockReturnValueOnce(pending.promise);
    await act(async () => current.setSearchQuery("שלום"));
    expect(history.search).toHaveBeenCalledTimes(1);
    history.search.mockResolvedValueOnce({ items: [at("a", 400), at("e", 350)], nextCursor: 350 });
    await act(async () => current.prependTranscript(at("a", 400), false));
    expect(current.items.map(item => item.id)).toEqual(["a", "e"]);
    history.search.mockResolvedValueOnce(page());
    await act(async () => current.loadMore());
    expect(history.search).toHaveBeenLastCalledWith("שלום", 20, 350);
  });

  it("preserves the history and rejects when bulk deletion returns false", async () => {
    history.list.mockResolvedValue(page(record("a"), record("b"))); history.deleteAll.mockResolvedValue(false);
    await render(<Harness />);
    await act(async () => { await expect(current.deleteAllTranscripts()).rejects.toThrow("התמלולים לא נמחקו"); });
    expect(current.items.map(item => item.id)).toEqual(["a", "b"]); expect(current.selectedTranscript?.id).toBe("a");
  });
});

describe("history deletion confirmation", () => {
  it("focuses cancellation first, supports Escape, and leaves data untouched", async () => {
    await renderContext(<HistoryPanel />); await act(async () => button(he.delete).click());
    expect(context.transcripts.deleteTranscript).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button("ביטול"));
    await act(async () => button("ביטול").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector(".history-delete-confirmation")).toBeNull(); expect(document.activeElement).toBe(button(he.delete));
  });

  it("prevents duplicate confirmation and reports a failed deletion", async () => {
    const pending = deferred<boolean>(); vi.mocked(context.transcripts.deleteTranscript).mockReturnValue(pending.promise);
    await renderContext(<HistoryPanel />); await act(async () => button(he.delete).click());
    const confirm = button("מחיקת התמלול"); await act(async () => { confirm.click(); confirm.click(); });
    expect(context.transcripts.deleteTranscript).toHaveBeenCalledExactlyOnceWith("a"); expect(button("מוחקים…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.reject(new Error("Denied")));
    expect(context.setErrorMessage).toHaveBeenCalledWith("התמלול לא נמחק. אפשר לנסות שוב.");
    expect(button("מחיקת התמלול").disabled).toBe(false);
  });

  it("resets confirmation on selection change and keeps a pending delete bound to its original id", async () => {
    const pending = deferred<boolean>(); vi.mocked(context.transcripts.deleteTranscript).mockReturnValue(pending.promise);
    await renderContext(<HistoryPanel />); await act(async () => button(he.delete).click());
    await act(async () => button("מחיקת התמלול").click());
    context.transcripts.selectedId = "b"; context.transcripts.selectedTranscript = record("b");
    await renderContext(<HistoryPanel />); expect(host.querySelector(".history-delete-confirmation")).toBeNull();
    await act(async () => pending.resolve(true));
    expect(context.transcripts.deleteTranscript).toHaveBeenCalledExactlyOnceWith("a");
    expect(context.transcripts.refresh).toHaveBeenCalledOnce(); expect(context.transcripts.selectedId).toBe("b");
  });

  it("keeps focused confirmation reachable while pending and restores the remaining list on success", async () => {
    const pending = deferred<boolean>(); vi.mocked(context.transcripts.deleteTranscript).mockReturnValue(pending.promise);
    await renderContext(<HistoryPanel />); await act(async () => button(he.delete).click());
    const confirm = button("מחיקת התמלול"); confirm.focus();
    await act(async () => confirm.click()); expect(document.activeElement).toBe(confirm);
    context.transcripts.items = [record("b")]; context.transcripts.selectedId = "b"; context.transcripts.selectedTranscript = record("b");
    await renderContext(<HistoryPanel />); await act(async () => pending.resolve(true));
    expect(document.activeElement).toBe(host.querySelector('button[aria-pressed="true"]'));
  });
});

describe("YouTube action feedback", () => {
  it("deduplicates submission while preserving a newly typed URL", async () => {
    const pending = deferred<void>(); vi.mocked(context.submitYouTubeUrl).mockReturnValue(pending.promise);
    await renderContext(<YouTubeInputRow />); await typeUrl("https://youtu.be/abcdefghijk");
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(context.submitYouTubeUrl).toHaveBeenCalledOnce();
    await typeUrl("https://youtu.be/newnewnewab"); await act(async () => pending.resolve());
    expect(host.querySelector("input")!.value).toBe("https://youtu.be/newnewnewab");
  });

  it("keeps queue cancellation failures readable and retryable", async () => {
    context.appState.pendingYoutubeJob = { url: "https://youtu.be/abcdefghijk", title: "כותרת ארוכה ".repeat(20) };
    const pending = deferred<void>(); vi.mocked(context.cancelPendingYouTube).mockReturnValue(pending.promise);
    await renderContext(<YouTubeInputRow />);
    expect(host.querySelector('[role="status"]')!.className).not.toContain("truncate");
    await act(async () => { button(he.youtubeCancelPending).click(); button(he.youtubeCancelPending).click(); });
    expect(context.cancelPendingYouTube).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error("")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("ביטול ההמתנה");
    expect(button(he.youtubeCancelPending).disabled).toBe(false);
  });

  it("offers an inline retry instead of calling a failed history load an empty state", async () => {
    context.transcripts.items = []; context.transcripts.errorMessage = "התמלולים לא נטענו. אפשר לנסות שוב.";
    await renderContext(<RecentTranscripts />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("לא נטענו");
    expect(host.querySelector(".history-empty")).toBeNull();
    await act(async () => button(he.retry).click()); expect(context.transcripts.refresh).toHaveBeenCalledOnce();
  });
});
