import { describe, expect, it } from "vitest";
import { enhanceTranscript } from "@main/services/text-rules/transcript-enhancer.service";

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

  it("keeps a spoken mark said just before a line break", () => {
    expect(dictate("היי דני פסיק מה שלומך סימן שאלה שורה חדשה רציתי לשאול על הפגישה")).toBe("היי דני, מה שלומך?\nרציתי לשאול על הפגישה.");
    expect(dictate("רציתי לשאול שתי שאלות נקודתיים שורה חדשה מתי נפגשים סימן שאלה")).toBe("רציתי לשאול שתי שאלות:\nמתי נפגשים?");
    expect(dictate("איזה יופי סימן קריאה פסקה חדשה נתראה מחר")).toBe("איזה יופי!\n\nנתראה מחר.");
    expect(dictate("מה שלומך סימן שאלה. שורה חדשה. רציתי לשאול")).toBe("מה שלומך?\nרציתי לשאול.");
  });

  it("drops a comma Whisper put before a spoken line break", () => {
    expect(dictate("שלום, שורה חדשה מה נשמע")).toBe("שלום.\nמה נשמע?");
  });

  it.each([
    ["היי דני ירידת שורה מה נשמע", "היי דני.\nמה נשמע?"],
    ["מה שלומך סימת שאלה שורה חדשה תודה", "מה שלומך?\nתודה."]
  ])("hears the common variants of a command: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
  });

  it.each([
    [", אוקיי, זה בדיקה ראשונה.", "אוקיי, זה בדיקה ראשונה."],
    [", היי דני פסיק מה שלומך סימן שאלה", "היי דני, מה שלומך?"],
    [". שלום לכולם", "שלום לכולם."],
    ["היי דני שורה חדשה , מה נשמע", "היי דני.\nמה נשמע?"]
  ])("drops punctuation with no words before it: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
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

  it.each([
    ["אני אוהב את זה נקודה", "אני אוהב את זה."],
    ["ראיתי אותו נקודה", "ראיתי אותו."],
    ["אני מכיר אותה פסיק היא נחמדה", "אני מכיר אותה, היא נחמדה."],
    ["בוא נעשה את זה שורה חדשה תודה", "בוא נעשה את זה.\nתודה."]
  ])("reads a command after a pronoun it cannot belong to: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
  });

  it.each(["זו אותה נקודה", "זו נקודה חשובה מאוד"])("keeps the noun in %s", (text) => {
    expect(dictate(text)).toBe(`${text}.`);
  });

  it.each([
    "זו נקודה מצוינת",
    "זאת נקודה שכדאי לבדוק",
    "זה נקודה למחשבה",
    "זו נקודה",
    "זה שורה חדשה בקוד",
    "זה פסקה חדשה במסמך",
    "זה פסיק מיותר",
    "זאת פסיק",
    "יש על זה סימן שאלה גדול"
  ])("reads the noun after a demonstrative that opens the clause: %s", (text) => {
    expect(dictate(text)).toBe(`${text}.`);
  });

  it.each([
    ["את זה נקודה", "את זה."],
    ["על זה שורה חדשה תודה", "על זה.\nתודה."],
    ["תכתוב את זה פסיק ואז נמשיך", "תכתוב את זה, ואז נמשיך."],
    ["סיימתי עם זה נקודה", "סיימתי עם זה."]
  ])("reads a command after a pronoun that follows a preposition or את: %s", (spoken, written) => {
    expect(dictate(spoken)).toBe(written);
  });

  it.each(["הייתה ירידת שורה באמצע", "היה ירידת שורה במסמך"])("keeps a break said as a noun after a verb of being: %s", (text) => {
    expect(dictate(text)).toBe(`${text}.`);
  });

  it("merges a spoken נקודה into the period the model already wrote", () => {
    expect(dictate("רציתי לדעת אם אתה יכול לשלוח לי את ההצעת מחיר האחרונה שדיברנו עליה. נקודה. ירידת שורה. תודה רבה."))
      .toBe("רציתי לדעת אם אתה יכול לשלוח לי את ההצעת מחיר האחרונה שדיברנו עליה.\nתודה רבה.");
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
