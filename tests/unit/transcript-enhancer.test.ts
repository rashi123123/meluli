/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  detectUncertainSegments,
  enhanceTranscript,
  extractPossibleTerms
} from "@main/services/text-rules/transcript-enhancer.service";

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

describe("Hebrew punctuation", () => {
  const clean = (text: string) => enhanceTranscript(text, { removeFillerWords: false }).text;

  it("turns a clear question's period into a question mark", () => {
    expect(clean("למה זה לא עובד.")).toBe("למה זה לא עובד?");
    expect(clean("אז איך מתקנים את זה")).toBe("אז איך מתקנים את זה?");
    expect(clean("ומתי נפגשים.")).toBe("ומתי נפגשים?");
    expect(clean("זה מוכן, נכון.")).toBe("זה מוכן, נכון?");
  });

  it("keeps a statement that only starts like a question", () => {
    expect(clean("מה שחשוב זה הלקוח.")).toBe("מה שחשוב זה הלקוח.");
    expect(clean("איך שהוא הגיע התחלנו.")).toBe("איך שהוא הגיע התחלנו.");
    expect(clean("כמה ימים אחרי זה הוא חזר.")).toBe("כמה ימים אחרי זה הוא חזר.");
    expect(clean("איזה יופי!")).toBe("איזה יופי!");
  });

  it("adds a comma before אבל and אלא", () => {
    expect(clean("ניסיתי לפתוח את הקובץ אבל הוא לא נפתח.")).toBe("ניסיתי לפתוח את הקובץ, אבל הוא לא נפתח.");
    expect(clean("זה לא רק המחיר אלא גם הזמן.")).toBe("זה לא רק המחיר, אלא גם הזמן.");
    expect(clean("ניסיתי, אבל לא הלך.")).toBe("ניסיתי, אבל לא הלך.");
  });

  it("writes numbers in digits unless that is turned off", () => {
    expect(clean("עשרים אחוז מהמשתמשים חזרו.")).toBe("20% מהמשתמשים חזרו.");
    expect(enhanceTranscript("עשרים אחוז מהמשתמשים חזרו.", { removeFillerWords: false, numbersAsDigits: false }).text)
      .toBe("עשרים אחוז מהמשתמשים חזרו.");
  });

  it("reads a spoken decimal before נקודה becomes a period", () => {
    expect(enhanceTranscript("הגרסה היא שתיים נקודה חמש", { removeFillerWords: false, spokenCommands: true }).text).toContain("2.5");
  });
});

describe("repeats", () => {
  const dictate = (text: string) => enhanceTranscript(text, { removeFillerWords: true, spokenCommands: true }).text;

  it.each([
    ["אני מכיר את דני. דני חבר טוב שלי.", "אני מכיר את דני. דני חבר טוב שלי."],
    ["כן, כן", "כן, כן."],
    ["רגע, רגע, רגע.", "רגע, רגע, רגע."],
    ["תודה, תודה רבה", "תודה, תודה רבה."],
    ["זה הולך להיות קשה, קשה מאוד", "זה הולך להיות קשה, קשה מאוד."]
  ])("keeps a word repeated across a mark: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
  });

  it.each([
    ["תתקשר אפס חמש ארבע שבע שבע שבע שמונה שמונה שמונה שמונה", "תתקשר 054-7778888."],
    ["אפס חמש ארבע שלוש שתיים אחת אחת שתיים שלוש ארבע", "054-3211234."],
    ["לאט לאט נגיע", "לאט לאט נגיע."],
    ["יום יום אני רץ", "יום יום אני רץ."]
  ])("keeps digits and doubled idioms said twice on purpose: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
  });

  it.each([
    ["יש לי שלוש שלוש בעיות", "יש לי שלוש בעיות."],
    ["אחד אחד הדברים שהכי מפריעים לי", "אחד הדברים שהכי מפריעים לי."],
    ["אני רוצה שני שני כרטיסים", "אני רוצה שני כרטיסים."],
    ["זה עלה מאה מאה וחמישים שקל", "זה עלה 150 שקל."],
    ["המספר הוא שבע שבע שבע", "המספר הוא שבע שבע שבע."],
    ["פלוס אחת שתיים אחת שתיים חמש חמש חמש אחת שתיים שלוש ארבע", "פלוס אחת שתיים אחת שתיים חמש חמש חמש אחת שתיים שלוש ארבע."]
  ])("drops a repeated number unless it is a digit read digit by digit: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
  });

  it("still drops a stutter", () => {
    expect(dictate("זה זה זה טוב")).toBe("זה טוב.");
    expect(dictate("אני רוצה אני רוצה לנסות")).toBe("אני רוצה לנסות.");
  });
});

describe("questions and sentence ends", () => {
  const clean = (text: string) => enhanceTranscript(text, { removeFillerWords: false }).text;

  it.each(["מה שלומך", "מה שמך", "איך שלומך", "מה שמעת", "למה שאלת", "איפה שמת את המפתחות", "מי שלח את זה"])(
    "asks %s although the next word opens with ש", (text) => {
      expect(clean(text)).toBe(`${text}?`);
    });

  it("asks after a greeting or a name and a comma", () => {
    expect(clean("סליחה, איפה התחנה")).toBe("סליחה, איפה התחנה?");
    expect(clean("היי, מה קורה")).toBe("היי, מה קורה?");
    expect(clean("דני, מתי אתה מגיע")).toBe("דני, מתי אתה מגיע?");
    expect(clean("תגיד לי, למה זה לא עובד")).toBe("תגיד לי, למה זה לא עובד?");
    expect(clean("טוב, מה שחשוב זה הלקוח")).toBe("טוב, מה שחשוב זה הלקוח.");
  });

  it.each([
    "אני לא יודע, מה לעשות עם זה",
    "אין לי מושג, למה זה קרה",
    "לא יודע, מתי זה יהיה מוכן",
    "וואו, איזה יופי",
    "וואו, כמה אנשים באו"
  ])("does not ask after a comma that follows not knowing or an exclamation: %s", (text) => {
    expect(clean(text)).toBe(`${text}.`);
  });

  it.each([
    "מה שמעת זה לא נכון",
    "מה שאלת זאת שאלה טובה",
    "מה שמת בתיק זה שלי",
    "מי שלח את הטופס יקבל תשובה"
  ])("reads a ש clause with its own predicate as a statement: %s", (text) => {
    expect(clean(text)).toBe(`${text}.`);
  });

  it.each(["מי שלח את ההודעה הזאת", "מה שמעת על הפרויקט", "מה שמעת על זה"])("still asks %s", (text) => {
    expect(clean(text)).toBe(`${text}?`);
  });

  it.each(["אתה בא מחר, כן", "סגרנו על שמונה, כן", "אתה מסכים, כן"])("asks with a ', כן' tag: %s", (text) => {
    expect(clean(text)).toBe(`${text}?`);
  });

  it("does not ask an answer", () => {
    expect(clean("בסדר, כן")).toBe("בסדר, כן.");
    expect(clean("הוא שאל אם אני בא ואמרתי, כן")).toBe("הוא שאל אם אני בא ואמרתי, כן.");
    expect(clean("הבנתי, כן")).toBe("הבנתי, כן.");
    expect(clean("שאלתי אותו והוא אמר, לא")).toBe("שאלתי אותו והוא אמר, לא.");
    expect(clean("זה נכון, לא")).toBe("זה נכון, לא?");
  });

  it("does not cut a long sentence in the middle of a phrase", () => {
    const text = "עכשיו אני רוצה לדבר על משהו אחר לגמרי אבל קודם כל צריך לסגור את מה שהתחלנו עם הלקוח החדש שלנו מאתמול";
    expect(clean(text)).toBe("עכשיו אני רוצה לדבר על משהו אחר לגמרי, אבל קודם כל צריך לסגור את מה שהתחלנו עם הלקוח החדש שלנו מאתמול.");
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
