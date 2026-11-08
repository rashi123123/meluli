/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { applyHebrewNumbers } from "@main/services/text-rules/hebrew-numbers";

describe("applyHebrewNumbers", () => {
  it.each([
    ["לפני כעשרת אלפים שנה", "לפני כ-10,000 שנה"],
    ["עשרים ושלושה אנשים הגיעו", "23 אנשים הגיעו"],
    ["מאה ועשרים שנה", "120 שנה"],
    ["בשנת אלף תשע מאות ותשעים ושמונה", "בשנת 1998"],
    ["היו שם שלוש מאות איש", "היו שם 300 איש"],
    ["שנים עשר שבטים", "12 שבטים"],
    ["בן עשרים", "בן 20"],
    ["שני מיליון משתמשים", "2 מיליון משתמשים"],
    ["עשרים, שלושים, ארבעים", "20, 30, 40"]
  ])("writes %s in digits", (spoken, written) => {
    expect(applyHebrewNumbers(spoken)).toBe(written);
  });

  it.each([
    ["עשרים אחוז מהמשתמשים", "20% מהמשתמשים"],
    ["חמישה אחוזים.", "5%."],
    ["בחמישה עשר באוגוסט", "ב-15 באוגוסט"],
    ["נפגשים בשעה שמונה ועשרים", "נפגשים בשעה 8:20"],
    ["בשעה שלוש וחצי בבוקר", "בשעה 3:30 בבוקר"],
    ["בשעה עשרים ושתיים", "בשעה 22:00"],
    ["שלושים ושבע נקודה שתיים מעלות", "37.2 מעלות"]
  ])("reads percent, dates, times and decimals in %s", (spoken, written) => {
    expect(applyHebrewNumbers(spoken)).toBe(written);
  });

  it.each([
    "שבע אוניות",
    "אחד האטרקציות",
    "באר שבע",
    "יום שני הבא",
    "אלף תודות",
    "מיליון דולר",
    "במאה השלישית לפני הספירה",
    "בשנות העשרים",
    "נפגשנו בשמונה ועשרים",
    "ב-1990 הוא נוסף",
    "  רווח בהתחלה ובסוף  "
  ])("leaves %s as it is", (text) => {
    expect(applyHebrewNumbers(text)).toBe(text);
  });

  it.each([
    ["לפני עשרים שנים גרתי שם", "לפני 20 שנים גרתי שם"],
    ["מאה שנים", "מאה שנים"],
    ["אלף שנים", "אלף שנים"],
    ["מיליון שנים", "מיליון שנים"],
    ["עשרים שנים ושלושה חודשים", "20 שנים ושלושה חודשים"],
    ["שנים עשר חודשים", "12 חודשים"]
  ])("reads שנים as years, not two: %s", (spoken, written) => {
    expect(applyHebrewNumbers(spoken)).toBe(written);
  });

  it("keeps the percent after a spoken decimal", () => {
    expect(applyHebrewNumbers("עשרים ושלוש נקודה שבע אחוז")).toBe("23.7%");
    expect(applyHebrewNumbers("תשעים ושתיים נקודה חמש")).toBe("92.5");
  });
});
