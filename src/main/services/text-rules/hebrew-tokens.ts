/** Word-level pieces the spoken-text passes share, so they read a sentence the same way. */

export const HEBREW_MONTHS = new Set(["ינואר", "פברואר", "מרץ", "מרס", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]);

const TRAILING_PUNCTUATION = /[,.;:!?)"'״]+$/u;

export interface Word {
  /** The whole token as it appears, punctuation included. */
  raw: string;
  /** The word without trailing punctuation. */
  core: string;
  trailing: string;
}

export function splitTrailing(raw: string): Word {
  const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  return { raw, core: raw.slice(0, raw.length - trailing.length), trailing };
}

/** The words of a text, and the exact whitespace after each, so the text can be put back together unchanged. */
export function splitWords(text: string): { words: Word[]; spaceAfter: (wordIndex: number) => string } {
  // Words sit at even indexes and the whitespace after each one at the odd index that follows.
  const parts = text.split(/(\s+)/u);
  return {
    words: parts.filter((_, index) => index % 2 === 0).map(splitTrailing),
    spaceAfter: (wordIndex) => parts[wordIndex * 2 + 1] ?? ""
  };
}

/** A token without the punctuation around it: "(שלום," is שלום. */
export const bare = (token: string): string => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
