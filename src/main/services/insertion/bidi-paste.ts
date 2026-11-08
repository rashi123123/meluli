import { TERMINAL_APPS, withoutControls } from "./target-format";

/**
 * Hebrew text that starts with an English word, or ends with punctuation, is laid out
 * by the receiving field's own bidi rules: a field that takes its direction from the
 * first strong letter turns "Claude Code זה כלי." into a left-to-right line, and a
 * left-to-right field puts the closing "?" on the wrong side. One invisible
 * RIGHT-TO-LEFT MARK at each end of an affected line fixes both. Only the pasted copy
 * changes; the stored transcript keeps the text exactly as transcribed.
 */
const RLM = "‏";
const RTL_LETTER = /(?=\p{L})[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;
const BIDI_CONTROL = /[‎‏؜‪-‮⁦-⁩]/u;
/** Punctuation and symbols at the end of a line, with any spaces after them. */
const TRAILING_NEUTRALS = /[\p{P}\p{S}][\p{P}\p{S}\s]*$/u;

/**
 * Code editors and terminals keep every character literally, and most terminals ignore
 * bidi altogether, so an invisible mark there only ends up inside a prompt or a file.
 */
const LITERAL_TARGETS = new Set([
  ...TERMINAL_APPS,
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.vscodium",
  "com.todesktop.230313mzl4w4u92",
  "com.exafunction.windsurf",
  "dev.zed.Zed",
  "com.sublimetext.4",
  "com.panic.Nova",
  "com.apple.dt.Xcode"
]);

function isLiteralTarget(bundleId: string | null | undefined): boolean {
  if (!bundleId) return false;
  return LITERAL_TARGETS.has(bundleId) || bundleId.startsWith("com.jetbrains.") || bundleId.startsWith("com.google.android.studio");
}

function firstStrongIsLeftToRight(line: string): boolean {
  for (const character of line) {
    if (BIDI_CONTROL.test(character)) return false;
    if (LETTER.test(character)) return !RTL_LETTER.test(character);
  }
  return false;
}

function lastStrongIsRightToLeft(text: string): boolean {
  const characters = [...text];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    if (BIDI_CONTROL.test(character)) return false;
    if (LETTER.test(character)) return RTL_LETTER.test(character);
  }
  return false;
}

function protectLine(line: string): string {
  if (!RTL_LETTER.test(line)) return line;
  let result = line;
  const trailing = TRAILING_NEUTRALS.exec(result);
  if (trailing && lastStrongIsRightToLeft(result.slice(0, trailing.index))) {
    const marks = trailing[0].trimEnd();
    const at = trailing.index + marks.length;
    result = result.slice(0, at) + RLM + result.slice(at);
  }
  if (firstStrongIsLeftToRight(result)) {
    const indent = /^\s*/u.exec(result)![0];
    result = indent + RLM + result.slice(indent.length);
  }
  return result;
}

/** Returns the text to paste into `bundleId`. Text without right-to-left letters is returned unchanged. */
export function prepareTextForPaste(text: string, bundleId?: string | null): string {
  text = withoutControls(text);
  if (!RTL_LETTER.test(text) || isLiteralTarget(bundleId)) return text;
  return text.split("\n").map(protectLine).join("\n");
}
