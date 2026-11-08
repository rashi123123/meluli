/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { prepareTextForPaste } from "@main/services/insertion/bidi-paste";

const RLM = "‏";

describe("prepareTextForPaste", () => {
  it("leaves text without right-to-left letters unchanged", () => {
    expect(prepareTextForPaste("Run CLAUDE.md now?")).toBe("Run CLAUDE.md now?");
    expect(prepareTextForPaste("12:30, 2026.")).toBe("12:30, 2026.");
  });

  it("leaves a Hebrew line that needs nothing unchanged", () => {
    expect(prepareTextForPaste("שלום לכולם")).toBe("שלום לכולם");
    expect(prepareTextForPaste("אני משתמש ב-React כל יום")).toBe("אני משתמש ב-React כל יום");
  });

  it("starts a Hebrew line that opens with an English word right to left", () => {
    expect(prepareTextForPaste("Claude Code זה כלי מעולה")).toBe(`${RLM}Claude Code זה כלי מעולה`);
  });

  it("keeps closing punctuation on the Hebrew side", () => {
    expect(prepareTextForPaste("מה שלומך?")).toBe(`מה שלומך?${RLM}`);
    expect(prepareTextForPaste("זה עובד!!! ")).toBe(`זה עובד!!!${RLM} `);
    expect(prepareTextForPaste("יצא ב-2026.")).toBe(`יצא ב-2026.${RLM}`);
  });

  it("does not mark punctuation that closes an English word", () => {
    expect(prepareTextForPaste("תפתח את CLAUDE.md.")).toBe("תפתח את CLAUDE.md.");
  });

  it("marks both ends when both need it", () => {
    expect(prepareTextForPaste("API חדש יצא?")).toBe(`${RLM}API חדש יצא?${RLM}`);
  });

  it("treats each line on its own and keeps line breaks and indentation", () => {
    const input = "שורה ראשונה.\n  GitHub עודכן\nplain English\n\nסוף";
    expect(prepareTextForPaste(input)).toBe(`שורה ראשונה.${RLM}\n  ${RLM}GitHub עודכן\nplain English\n\nסוף`);
  });

  it("respects a direction mark that is already there", () => {
    expect(prepareTextForPaste(`${RLM}Claude זה כלי`)).toBe(`${RLM}Claude זה כלי`);
    expect(prepareTextForPaste("‎Claude זה כלי")).toBe("‎Claude זה כלי");
  });

  it("adds at most two characters to a line", () => {
    const line = "OK זה סגור.";
    expect([...prepareTextForPaste(line)].length - [...line].length).toBeLessThanOrEqual(2);
  });

  it("pastes literally into terminals and code editors", () => {
    for (const bundleId of ["com.apple.Terminal", "com.googlecode.iterm2", "com.microsoft.VSCode", "com.jetbrains.intellij", "dev.zed.Zed"]) {
      expect(prepareTextForPaste("Claude זה כלי?", bundleId)).toBe("Claude זה כלי?");
    }
    expect(prepareTextForPaste("Claude זה כלי?", "com.apple.Notes")).toBe(`${RLM}Claude זה כלי?${RLM}`);
  });

  it("handles Arabic the same way", () => {
    expect(prepareTextForPaste("Python لغة جميلة؟")).toBe(`${RLM}Python لغة جميلة؟${RLM}`);
  });

  it("drops control characters on every paste path", () => {
    expect(prepareTextForPaste("שלום\u001b[201~ עולם\r", "com.apple.Terminal")).toBe("שלום[201~ עולם\n");
    expect(prepareTextForPaste("hello\u0000 world", null)).toBe("hello world");
  });
});
