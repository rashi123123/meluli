import { describe, expect, it } from "vitest";
import { enhanceTranscript } from "@main/services/transcript-enhancer.service";

const dictate = (text: string) => enhanceTranscript(text, { removeFillerWords: true, spokenCommands: true }).text;
const clean = (text: string) => enhanceTranscript(text, { removeFillerWords: true }).text;

describe("spoken commands", () => {
  it.each([
    ["מה קורה סימן שאלה אני בדרך", "מה קורה? אני בדרך"],
    ["איזה יופי סימן קריאה", "איזה יופי!"],
    ["חלב פסיק ביצים נקודה", "חלב, ביצים."],
    ["יש שלושה דברים נקודתיים חלב", "יש שלושה דברים: חלב"],
    ["בית מקף ספר", "בית-ספר"],
    ["הבעיה קו מפריד הזמן", "הבעיה – הזמן"],
    ["שלום, סימן שאלה", "שלום?"]
  ])("%s", (spoken, written) => {
    expect(dictate(spoken).replace(/\.$/u, "")).toBe(written.replace(/\.$/u, ""));
  });

  it("keeps spoken line and paragraph breaks through the sentence split", () => {
    expect(dictate("שורה ראשונה שורה חדשה שורה שנייה").split("\n")).toHaveLength(2);
    expect(dictate("פסקה ראשונה פסקה חדשה פסקה שנייה").split("\n\n")).toHaveLength(2);
  });

  it.each([
    "זו נקודה חשובה בדיון",
    "יש על זה סימן שאלה גדול",
    "תוסיף שורה חדשה בסוף הקובץ",
    "נקודה טובה",
    "נקודה"
  ])("leaves the ordinary sentence %s alone", (text) => {
    expect(dictate(text).replace(/[.?]$/u, "")).toBe(text);
  });

  it("does not touch the raw text, and stays off unless asked", () => {
    expect(enhanceTranscript("מה קורה סימן שאלה", { removeFillerWords: true, spokenCommands: true }).rawText).toBe("מה קורה סימן שאלה");
    expect(clean("מה קורה סימן שאלה בדיוק")).toContain("סימן שאלה");
  });
});

describe("filler cleanup", () => {
  it.each([
    ["זה יעני עובד", "זה עובד"],
    ["אמממ זה עובד", "זה עובד"],
    ["זה היה טוב, כאילו, ממש טוב", "זה היה טוב, ממש טוב"],
    ["זה היה טוב כאילו", "זה היה טוב"],
    ["זה היה טוב כאילו. הלכנו לים", "זה היה טוב. הלכנו לים"],
    ["הלכנו, נגיד, לים", "הלכנו, לים"],
    ["אני רוצה אני רוצה לנסות", "אני רוצה לנסות"],
    ["אני לא יודע אני לא יודע מה לעשות", "אני לא יודע מה לעשות"]
  ])("%s", (spoken, written) => {
    expect(clean(spoken).replace(/\.$/u, "")).toBe(written);
  });

  it.each(["הוא עושה כאילו הוא ישן", "נגיד שזה עובד", "הוא התנהג כאילו כלום לא קרה"])("keeps %s", (text) => {
    expect(clean(text).replace(/\.$/u, "")).toBe(text);
  });
});
