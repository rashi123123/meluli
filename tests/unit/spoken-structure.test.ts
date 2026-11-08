import { describe, expect, it } from "vitest";
import { textWithPauses } from "@main/services/text-rules/pause-punctuation";
import { applySelfCorrections } from "@main/services/text-rules/self-corrections";
import { applySpokenContacts } from "@main/services/text-rules/spoken-contacts";
import { applySpokenLists, resolveListNumbers } from "@main/services/text-rules/spoken-lists";
import { enhanceTranscript } from "@main/services/text-rules/transcript-enhancer.service";

const dictate = (text: string, extra: Parameters<typeof enhanceTranscript>[1] extends infer O ? Partial<O> : never = {}) =>
  enhanceTranscript(text, { removeFillerWords: true, spokenCommands: true, ...extra }).text;

describe("pauses", () => {
  const segments = [
    { start: 0, end: 2, text: "היום הלכנו לים והיה ממש כיף" },
    { start: 3.5, end: 6, text: "שם כל היום בשמש החמה" },
    { start: 6.2, end: 9, text: "ואז חזרנו הביתה מאוחר בערב" }
  ];
  const text = segments.map((segment) => segment.text).join(" ");

  it("ends a sentence at a clear pause and leaves short gaps alone", () => {
    expect(textWithPauses(text, segments)).toBe("היום הלכנו לים והיה ממש כיף. שם כל היום בשמש החמה ואז חזרנו הביתה מאוחר בערב");
  });

  it("starts a paragraph after a long pause once the paragraph has some length", () => {
    const long = [
      { start: 0, end: 4, text: "היום הלכנו לים עם החברים והיה ממש כיף שם כל היום בשמש." },
      { start: 7, end: 9, text: "מחר נחזור לעבודה" }
    ];
    expect(dictate(long.map((segment) => segment.text).join(" "), { segments: long })).toBe(
      "היום הלכנו לים עם החברים והיה ממש כיף שם כל היום בשמש.\n\nמחר נחזור לעבודה."
    );
  });

  it("does not end a sentence before a word that continues it", () => {
    const continuing = [
      { start: 0, end: 2, text: "אני חושב שזה רעיון טוב" },
      { start: 3.5, end: 5, text: "אבל צריך לבדוק" }
    ];
    expect(textWithPauses("אני חושב שזה רעיון טוב אבל צריך לבדוק", continuing)).toBe("אני חושב שזה רעיון טוב אבל צריך לבדוק");
  });

  it("keeps a spoken mark, a correction and a phone number said after a pause", () => {
    const timed = (...pieces: [string, number][]) => {
      let at = 0;
      const timedSegments = pieces.map(([piece, pause]) => {
        const segment = { start: at + pause, end: at + pause + 2, text: piece };
        at = segment.end;
        return segment;
      });
      return dictate(timedSegments.map((segment) => segment.text).join(" "), { segments: timedSegments });
    };
    expect(timed(["אני רוצה לספר לכם על מה שקרה לנו היום בבוקר בדרך לעבודה כשנסענו מהר", 0], ["סימן שאלה", 2.5]))
      .toBe("אני רוצה לספר לכם על מה שקרה לנו היום בבוקר בדרך לעבודה כשנסענו מהר?");
    expect(timed(["נפגש ביום שני", 0], ["סליחה ביום שלישי", 1.5])).toBe("נפגש ביום שלישי.");
    expect(timed(["המספר שלי אפס חמש ארבע", 0], ["שלוש שתיים אחת ארבע חמש שש שבע", 1.2])).toBe("המספר שלי 054-3214567.");
    expect(timed(["היינו שם כל היום בשמש", 0], ["ירידת שורה ואז חזרנו", 1.5])).toBe("היינו שם כל היום בשמש.\nואז חזרנו.");
  });

  it.each([
    ["אני חושב שזה רעיון ממש טוב", "נקודה חשובה נוספת היא התקציב"],
    ["הגענו לשם בזמן ונכנסנו פנימה", "שורה של אנשים חיכתה בחוץ"],
    ["הוא הגיע ממש בזמן הבוקר", "סימן טוב להמשך היום"],
    ["הגעתי מאוחר לפגישה היום", "סליחה על האיחור"],
    ["רציתי להגיע אליכם אתמול", "התכוונתי לבוא אבל לא הספקתי"],
    ["נפגש ביום שלישי בבוקר", "סליחה ביום רביעי"]
  ])("ends the sentence at a pause before ordinary speech that only opens like a command: %s ‖ %s", (before, after) => {
    const timed = [{ start: 0, end: 2, text: before }, { start: 3.5, end: 5, text: after }];
    expect(textWithPauses(`${before} ${after}`, timed, { spokenCommands: true })).toBe(`${before}. ${after}`);
  });

  it("joins a spoken mark said after a long pause to the period before it", () => {
    const timed = [
      { start: 0, end: 4, text: "רציתי לדעת אם אתה יכול לשלוח לי את ההצעת מחיר האחרונה שדיברנו עליה." },
      { start: 6.6, end: 7, text: "נקודה." },
      { start: 7.4, end: 8, text: "ירידת שורה." },
      { start: 8.5, end: 9, text: "תודה רבה." }
    ];
    expect(dictate(timed.map((segment) => segment.text).join("  "), { segments: timed }))
      .toBe("רציתי לדעת אם אתה יכול לשלוח לי את ההצעת מחיר האחרונה שדיברנו עליה.\nתודה רבה.");
  });

  it.each([
    ["סיימנו את הרבעון עם עשרים", "שלושה לקוחות חדשים הצטרפו", "סיימנו את הרבעון עם 20. שלושה לקוחות חדשים הצטרפו."],
    ["קניתי שלושה ספרים חדשים ושילמתי מאה", "שני ספרים כבר קראתי", "קניתי שלושה ספרים חדשים ושילמתי מאה. שני ספרים כבר קראתי."],
    ["זה היה בשנת אלפיים", "שלושה חודשים אחר כך עברנו", "זה היה בשנת אלפיים. שלושה חודשים אחר כך עברנו."],
    ["המספר שלי אפס חמש ארבע שתיים", "שלוש ארבע חמש שש שבע", "המספר שלי 05-4234567."]
  ])("runs a number on across a pause only when it is read digit by digit: %s ‖ %s", (before, after, written) => {
    const timed = [{ start: 0, end: 2, text: before }, { start: 3.5, end: 5, text: after }];
    expect(dictate(`${before} ${after}`, { segments: timed })).toBe(written);
  });

  it("ignores segments that do not spell the text", () => {
    expect(textWithPauses("טקסט אחר לגמרי", segments)).toBeNull();
    expect(textWithPauses(text, null)).toBeNull();
  });
});

describe("spoken contacts", () => {
  it("writes an email address", () => {
    expect(applySpokenContacts("תשלח ל dani שטרודל ג'ימייל נקודה קום עד מחר")).toBe("תשלח ל-dani@gmail.com עד מחר");
    expect(applySpokenContacts("הכתובת dani.cohen שטרודל walla נקודה co נקודה il.")).toBe("הכתובת dani.cohen@walla.co.il.");
  });

  it("writes a web address that opens with a Latin name", () => {
    expect(applySpokenContacts("האתר הוא meluli נקודה קו נקודה איל ותיכנס")).toBe("האתר הוא meluli.co.il ותיכנס");
    expect(applySpokenContacts("github נקודה קום סלאש meluli")).toBe("github.com/meluli");
  });

  it("drops the trunk 0 said after 972", () => {
    expect(applySpokenContacts("פלוס תשע שבע שתיים אפס חמש ארבע שלוש שתיים אחת שתיים שלוש ארבע חמש")).toBe("+972-54-3212345");
    expect(applySpokenContacts("פלוס תשע שבע שתיים חמש ארבע שלוש שתיים אחת שתיים שלוש ארבע חמש")).toBe("+972-54-3212345");
  });

  it("writes a phone number said digit by digit", () => {
    expect(applySpokenContacts("המספר שלי אפס חמש ארבע, שלוש אחת שתיים, ארבע חמש שש שבע תתקשר")).toBe("המספר שלי 054-3124567 תתקשר");
    expect(applySpokenContacts("תתקשר לאפס שתיים שש שלוש אחת שתיים שלוש ארבע חמש.")).toBe("תתקשר ל-02-6312345.");
  });

  it("leaves numbers, decimals and Hebrew words alone", () => {
    for (const text of ["שתיים נקודה חמש אחוז", "שלוש ארבע חמש", "אמרתי נקודה קום ותלך", "הגרסה 2 נקודה 5"]) {
      expect(applySpokenContacts(text)).toBe(text);
    }
  });
});

describe("self-corrections", () => {
  it("keeps the corrected number, time or day", () => {
    expect(applySelfCorrections("נפגש בשלוש, סליחה, בארבע אצלי")).toBe("נפגש בארבע אצלי");
    expect(applySelfCorrections("נפגש בשלוש, סליחה, ארבע אצלי")).toBe("נפגש בארבע אצלי");
    expect(applySelfCorrections("ביום שני, סליחה, ביום שלישי בבוקר")).toBe("ביום שלישי בבוקר");
    expect(applySelfCorrections("זה עולה 50, רגע, לא, 60 שקל")).toBe("זה עולה 60 שקל");
    expect(applySelfCorrections("נדבר מחר, לא רגע, מחרתיים")).toBe("נדבר מחרתיים");
  });

  it("leaves an ordinary סליחה alone", () => {
    for (const text of ["סליחה, אפשר לשאול?", "יש לי שלוש, סליחה, אני לא יודע", "נגמר בשלוש. סליחה, ארבע"]) {
      expect(applySelfCorrections(text)).toBe(text);
    }
  });

  it("drops the repair's prefix after a lead word, and writes the new time in digits", () => {
    expect(applySelfCorrections("ביום שני, סליחה, בשלישי")).toBe("ביום שלישי");
    expect(applySelfCorrections("בשעה 3:30, סליחה, בחמש וחצי")).toBe("בשעה חמש וחצי");
    expect(dictate("פגישה בשעה שלוש וחצי, סליחה, בחמש וחצי, אם אפשר")).toBe("פגישה בשעה 5:30, אם אפשר.");
    expect(dictate("עד שלוש, סליחה, עד ארבע")).toBe("עד ארבע.");
  });

  it("runs only with spoken commands, so a lecture keeps every word", () => {
    expect(enhanceTranscript("נפגש בשלוש, סליחה, בארבע", { removeFillerWords: false }).text).toBe("נפגש בשלוש, סליחה, בארבע.");
    expect(dictate("נפגש בשלוש, סליחה, בארבע")).toBe("נפגש בארבע.");
  });
});

describe("spoken lists", () => {
  it("numbers items said with דבר ראשון, דבר שני", () => {
    expect(dictate("יש כמה דברים לעשות. דבר ראשון, לקנות חלב. דבר שני, לנקות את הבית. ודבר שלישי לשלם חשבונות. אחר כך נדבר על הטיול."))
      .toBe("יש כמה דברים לעשות:\n1. לקנות חלב.\n2. לנקות את הבית.\n3. לשלם חשבונות.\n\nאחר כך נדבר על הטיול.");
  });

  it("numbers items said with ראשית, שנית and ולבסוף", () => {
    expect(dictate("ראשית צריך לבדוק את הקוד, שנית להריץ בדיקות ולבסוף לפרסם")).toBe("1. צריך לבדוק את הקוד.\n2. להריץ בדיקות.\n3. לפרסם.");
  });

  it("makes no empty item", () => {
    expect(dictate("דבר ראשון, דבר שני")).toBe("דבר ראשון, דבר שני.");
    expect(dictate("דבר ראשון התקציב. דבר שני הגיוס. דבר שלישי")).toBe("1. התקציב.\n2. הגיוס.\n\nדבר שלישי.");
    expect(dictate("דבר ראשון, דבר שני, הכי חשוב זה הבריאות")).toBe("דבר ראשון, דבר שני, הכי חשוב זה הבריאות.");
  });

  it("drops an empty item inside the list and keeps the rest", () => {
    expect(dictate("דבר ראשון חלב, דבר שני לחם, דבר שלישי, דבר רביעי ביצים")).toBe("1. חלב.\n2. לחם.\n3. ביצים.");
  });

  it("needs the first marker and a second one in order", () => {
    for (const text of ["ראשית אני רוצה להודות לכולם", "יש עוד דבר שני שחשוב", "דבר ראשון לבדוק ודבר שלישי לפרסם"]) {
      expect(resolveListNumbers(applySpokenLists(text))).toBe(text);
    }
  });
});

describe("prefix hyphens", () => {
  it("gives a Hebrew prefix on a Latin word the same maqaf the term rules write", () => {
    expect(dictate("פתחתי את הטיקט ב-Jira וב-Slack")).toBe("פתחתי את הטיקט ב־Jira וב־Slack.");
    expect(dictate("נפגש ב-2024 עם x-ray")).toBe("נפגש ב-2024 עם x-ray.");
  });
});
