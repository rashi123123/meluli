/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  detectUncertainSegments,
  enhanceTranscript,
  extractPossibleTerms
} from "@main/services/transcript-enhancer.service";

describe("enhanceTranscript", () => {
  it("restores punctuation, removes filler words, and builds paragraphs", () => {
    const result = enhanceTranscript(
      "אה אני רוצה לדבר על OpenAI היום אממ אנחנו בודקים תאריך 12 / 03 / 2026 ואז עוברים לנושא הבא אבל יש גם חלק נוסף",
      { removeFillerWords: true }
    );

    expect(result.rawText).toContain("12 / 03 / 2026");
    expect(result.text).toContain("12/03/2026");
    expect(result.text).not.toContain("אממ");
    expect(result.text).toContain("OpenAI");
    expect(result.paragraphs.length).toBeGreaterThan(0);
    expect(result.text).toContain(".");
  });

  it.each([
    ["קראתי את CLAUDE.md אתמול", "CLAUDE.md"],
    ["השרת רץ על localhost:3000 כרגע", "localhost:3000"],
    ["הקישור הוא https://example.com/a?b=1 בבקשה", "https://example.com/a?b=1"],
    ["המפתח נמצא ב ~/.ssh אצלי", "~/.ssh"],
    ["תוסיף משתנה לקובץ .env עכשיו", "קובץ .env"]
  ])("keeps technical punctuation in %s", (raw, expected) => {
    const result = enhanceTranscript(raw, { removeFillerWords: false });
    expect(result.text).toContain(expected);
    expect(enhanceTranscript(result.text, { removeFillerWords: false }).text).toContain(expected);
  });

  it("still separates Hebrew punctuation and does not count a file name as a sentence end", () => {
    expect(enhanceTranscript("שלום,עולם!", { removeFillerWords: false }).text).toBe("שלום, עולם!");

    const words = Array.from({ length: 30 }, (_, index) => `מילה${index}`).join(" ");
    const result = enhanceTranscript(`קראתי את CLAUDE.md ${words}`, { removeFillerWords: false });
    expect(result.text.match(/[.!?](?=\s|$)/gu)?.length).toBeGreaterThan(1);
  });

  it("keeps filler words when the option is disabled", () => {
    const result = enhanceTranscript("אה זה טקסט קצר", { removeFillerWords: false });
    expect(result.text).toContain("אה");
  });
});

describe("numeric transcript formatting", () => {
  it.each([
    ["802.11 פועל בסטנדרט של 2.5 הגיגה הרז וגם 5.0 גיגה הרס", ["802.11", "2.5", "5.0"]],
    ["הפגישה בשעה 09:30 והמחיר הוא 1,234.50 שקלים.", ["09:30", "1,234.50"]],
    ["הגרסה היא 1.2.3 ונפגשים ב־24.10.2026.", ["1.2.3", "24.10.2026"]],
    ["התאריך הוא 12 / 03 / 2026 בשעה 10 : 15.", ["12/03/2026", "10:15"]],
    ["הערך הוא -0.25 והטווח הוא 1.5–2.5.", ["-0.25", "1.5–2.5"]]
  ] as const)("preserves numbers in %s", (input, expectedTokens) => {
    const result = enhanceTranscript(input, { removeFillerWords: false });
    expect(result.rawText).toBe(input);
    for (const token of expectedTokens) expect(result.text).toContain(token);
    expect(result.paragraphs).toHaveLength(1);
  });

  it("still separates punctuation between ordinary words", () => {
    expect(enhanceTranscript("שלום,עולם!איך הולך?טוב.", { removeFillerWords: false }).text)
      .toBe("שלום, עולם! איך הולך? טוב.");
  });
});

describe("extractPossibleTerms", () => {
  it("captures quoted and latin-script terms", () => {
    expect(extractPossibleTerms('דיברנו על "מילה" וגם על GPT-5 ו-OpenAI')).toEqual(["מילה", "GPT-5", "OpenAI"]);
  });
});

describe("detectUncertainSegments", () => {
  it("marks suspicious mixed-script or malformed tokens", () => {
    expect(detectUncertainSegments("יש כאן tokenשלום וגם מותג123 וטקסט רגיל")).toEqual([
      "tokenשלום",
      "מותג123"
    ]);
  });
});
