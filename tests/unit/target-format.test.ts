/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { formatForTarget, targetKind } from "@main/services/insertion/target-format";

describe("formatForTarget", () => {
  it("drops the closing period of a one-line chat message", () => {
    expect(formatForTarget("נפגשים מחר בעשר.", "com.tinyspeck.slackmacgap")).toBe("נפגשים מחר בעשר");
    expect(formatForTarget("מה קורה?", "net.whatsapp.WhatsApp")).toBe("מה קורה?");
    expect(formatForTarget("רגע...", "ru.keepcoder.Telegram")).toBe("רגע...");
  });

  it("keeps the periods of a longer chat message and closes up its paragraphs", () => {
    expect(formatForTarget("משפט ראשון. משפט שני.", "com.tinyspeck.slackmacgap")).toBe("משפט ראשון. משפט שני.");
    expect(formatForTarget("פסקה אחת.\n\nפסקה שתיים.", "com.apple.MobileSMS")).toBe("פסקה אחת.\nפסקה שתיים.");
  });

  it("gives a terminal a single line", () => {
    expect(formatForTarget("תריץ את הטסטים.\n\nואז תעשה commit.", "com.googlecode.iterm2")).toBe("תריץ את הטסטים. ואז תעשה commit.");
  });

  it("leaves every other app alone", () => {
    const text = "שלום.\n\nפסקה שנייה.";
    expect(formatForTarget(text, "com.apple.mail")).toBe(text);
    expect(formatForTarget(text, null)).toBe(text);
    expect(targetKind("com.microsoft.VSCode")).toBe("other");
  });

  it("never pastes a control character a terminal could act on", () => {
    const hostile = "ls\u001b[201~ rm -rf ~\rcurl x\u0007\u0085";
    for (const bundle of ["com.apple.Terminal", "com.googlecode.iterm2", "com.apple.TextEdit", null]) {
      const shaped = formatForTarget(hostile, bundle);
      expect(shaped, String(bundle)).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
    }
    expect(formatForTarget("a\rb", "com.apple.Terminal")).toBe("a b");
    expect(formatForTarget("a\r\nb\tc", "com.apple.TextEdit")).toBe("a\nb\tc");
  });
});
