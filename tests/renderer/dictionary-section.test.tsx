// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictionarySection } from "@/features/dictionary/DictionarySection";
import { he } from "@shared/locale";
import type { DictionaryEntry } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const entry: DictionaryEntry = { id: "1", heard: "מלולי", written: "Meluli" };
let host: HTMLDivElement, root: Root, onChange: ReturnType<typeof vi.fn>;

const show = (entries: DictionaryEntry[]) => act(async () => root.render(<DictionarySection entries={entries} busy={false} onChange={onChange as never} />));
const inputs = () => [...host.querySelectorAll("input")];
const button = (name: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name)!;
const status = () => host.querySelector("[role=status]")?.textContent;

async function fill(heard: string, written: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    [heard, written].forEach((value, index) => {
      setValue.call(inputs()[index], value);
      inputs()[index]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

beforeEach(() => {
  onChange = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("DictionarySection", () => {
  it("adds a trimmed entry and clears the form once it is saved", async () => {
    await show([entry]);
    await fill("  קלוד ", " Claude  ");
    await act(async () => button(he.dictionaryAdd).click());

    const next = onChange.mock.calls[0]?.[0] as DictionaryEntry[];
    expect(next).toEqual([entry, expect.objectContaining({ heard: "קלוד", written: "Claude" })]);
    expect(inputs()[0]!.value).toBe("  קלוד ");
    await show(next);
    expect(inputs().map(input => input.value)).toEqual(["", ""]);
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it("keeps what was typed when the save does not land", async () => {
    await show([entry]);
    await fill("קלוד", "Claude");
    await act(async () => button(he.dictionaryAdd).click());
    await show([entry]);
    expect(inputs().map(input => input.value)).toEqual(["קלוד", "Claude"]);
  });

  it("blocks a duplicate and an entry past the limit", async () => {
    await show([entry]);
    await fill(" מלולי", "Other");
    expect(status()).toBe(he.dictionaryDuplicate);
    await act(async () => button(he.dictionaryAdd).click());
    expect(onChange).not.toHaveBeenCalled();

    await show(Array.from({ length: 500 }, (_, index) => ({ id: `${index}`, heard: `מילה${index}`, written: "x" })));
    await fill("חדש", "new");
    expect(status()).toBe(he.dictionaryFull);
  });

  it("deletes one entry", async () => {
    await show([entry]);
    await act(async () => button(`${he.delete} מלולי`).click());
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
