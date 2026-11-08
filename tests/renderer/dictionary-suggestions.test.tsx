import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "@/context/app-context";
import { DictionarySuggestions, type OfferedSuggestion } from "@/features/transcript/DictionarySuggestions";
import { he } from "@shared/locale";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
const offered = (heard: string, written: string) => ({ heard, written, state: "offered" }) as OfferedSuggestion;

function Rows({ initial }: { initial: OfferedSuggestion[] }) {
  const [items, setItems] = useState(initial);
  return <DictionarySuggestions items={items} onChange={setItems} onEmptied={() => {}} />;
}

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("dictionary suggestions", () => {
  it("writes one suggestion at a time so a second add cannot drop the first", async () => {
    let finish!: () => void;
    const updateSetting = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const context = { settings: { dictionary: [] }, updateSetting } as unknown as AppContextValue;
    await act(async () => root.render(<AppContext.Provider value={context}><Rows initial={[offered("קלוד", "Claude"), offered("מלולי", "Meluli")]} /></AppContext.Provider>));
    const adds = () => [...host.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent === he.suggestionAdd);
    await act(async () => adds()[0]!.click());
    expect(adds()[1]!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => adds()[1]!.click());
    expect(updateSetting).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(adds()[0]!.getAttribute("aria-disabled")).not.toBe("true");
  });
});
