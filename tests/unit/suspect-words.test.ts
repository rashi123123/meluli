/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { splitSuspects } from "@/lib/suspect-words";

describe("splitting text around flagged words", () => {
  it("keeps punctuation outside the mark and every character in place", () => {
    const parts = splitSuspects("ראיתי (גיטHub). גיטHub שוב", new Set(["גיטHub"]));
    expect(parts).toEqual([{ text: "ראיתי (" }, { text: "גיטHub", suspect: true }, { text: "). " }, { text: "גיטHub", suspect: true }, { text: " שוב" }]);
    expect(parts.map(part => part.text).join("")).toBe("ראיתי (גיטHub). גיטHub שוב");
  });

  it("leaves text without flags whole", () => {
    expect(splitSuspects("שלום", new Set())).toEqual([{ text: "שלום" }]);
    expect(splitSuspects("שלום עולם", new Set(["אחר"]))).toEqual([{ text: "שלום עולם" }]);
  });
});
