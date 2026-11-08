
export interface TermEntry {
  heard: string;
  written: string;
}

interface CompiledTerm {
  written: string;
  /** A short phrase after a stripped letter is too likely to be another Hebrew word. */
  takesPrefix: boolean;
  /** The person's own entry, often a name: names take no ה, so הדור and העמית stay words. */
  personal: boolean;
}

export interface TermMatcher {
  terms: Map<string, CompiledTerm>;
  notPrefixed: Set<string>;
  maxWords: number;
}

export interface TermSources {
  /** The person's own dictionary. It wins over entries and takes a prefix more carefully. */
  personal?: readonly TermEntry[];
  /** Earlier sources win, so the person's own entries come first. */
  entries: readonly TermEntry[];
  notPrefixed?: readonly string[];
}

interface Token {
  start: number;
  end: number;
  key: string;
}

// A geresh belongs to its word, so ירה is not found inside ג'ירה and ברנץ' leaves nothing behind.
const WORD = /[\p{L}\p{M}\p{N}]+(?:['׳’‘"״“”][\p{L}\p{M}\p{N}]+|[._+#-][A-Za-z0-9]+)*['׳’‘]?/gu;
const PHRASE_GAP = /^(?:[ \t]+|[-־–])$/u;
const CONTINUES_AFTER = /[._/-]\p{L}/uy;
const HEBREW_PREFIXES = new Set("ובכלמהש");
const MAX_PREFIX_LETTERS = 2;
const MIN_PREFIXED_LETTERS = 3;
/** A name of three letters (אור, דור, תום) after a prefix is too often a Hebrew word: לאור, בתום. */
const MIN_PERSONAL_PREFIXED_LETTERS = 4;

function toKey(word: string): string {
  return word.replace(/[׳’‘]/gu, "'").replace(/[״“”]/gu, "\"").toLowerCase();
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    tokens.push({ start: match.index, end: match.index + match[0].length, key: toKey(match[0]) });
  }
  return tokens;
}

export function buildTermMatcher({ personal = [], entries, notPrefixed = [] }: TermSources): TermMatcher {
  const terms = new Map<string, CompiledTerm>();
  let maxWords = 0;

  const keyOf = (entry: TermEntry) => tokenize(entry.heard).map((token) => token.key).join(" ");
  // A word a pack also knows is a product or a term, not a name, so it keeps the pack's prefixes: "ה־Figma".
  const packKeys = new Set(entries.map(keyOf));

  for (const [index, entry] of [...personal, ...entries].entries()) {
    const written = entry.written.trim();
    const words = tokenize(entry.heard).map((token) => token.key);
    const key = words.join(" ");
    if (!key || !written || terms.has(key)) continue;
    const isPersonal = index < personal.length && !packKeys.has(key);

    const letters = key.replace(/[\s'"]/gu, "").length;
    const minimum = isPersonal ? MIN_PERSONAL_PREFIXED_LETTERS : MIN_PREFIXED_LETTERS;
    terms.set(key, { written, takesPrefix: letters >= minimum, personal: isPersonal });
    maxWords = Math.max(maxWords, words.length);
  }

  return { terms, notPrefixed: new Set(notPrefixed.map(toKey)), maxWords };
}

/** Whether these words open with a whole term of two words or more, as "איי איי" spells AI and "אל אל אם" LLM. */
export function termSpelledBy(matcher: TermMatcher, words: readonly string[]): boolean {
  const keys = words.slice(0, matcher.maxWords).flatMap((word) => tokenize(word).map((token) => token.key));
  for (let length = Math.min(matcher.maxWords, keys.length); length >= 2; length -= 1) {
    if (matcher.terms.has(keys.slice(0, length).join(" "))) return true;
  }
  return false;
}

function startsWithPrefix(word: string, prefixLength: number): boolean {
  for (let index = 0; index < prefixLength; index += 1) {
    if (!HEBREW_PREFIXES.has(word[index]!)) return false;
  }
  return word.length > prefixLength;
}

function findTerm(tokens: Token[], index: number, words: number, matcher: TermMatcher) {
  const rest = tokens.slice(index + 1, index + words).map((token) => token.key);
  const first = tokens[index]!.key;
  const exact = matcher.terms.get([first, ...rest].join(" "));
  if (exact) return { term: exact, prefixLength: 0 };
  if (matcher.notPrefixed.has(first)) return null;

  // One letter before two, and never before the whole word: בלוג must not become ב + לוג.
  for (let prefixLength = 1; prefixLength <= MAX_PREFIX_LETTERS; prefixLength += 1) {
    if (!startsWithPrefix(first, prefixLength)) continue;
    // הבלוג is ה + בלוג, a word of its own, not הב + לוג.
    if (matcher.notPrefixed.has(first.slice(prefixLength - 1))) return null;
    const term = matcher.terms.get([first.slice(prefixLength), ...rest].join(" "));
    if (term?.takesPrefix && !(term.personal && first.slice(0, prefixLength).includes("ה"))) return { term, prefixLength };
  }
  return null;
}

function phraseIsContinuous(text: string, tokens: Token[], index: number, words: number): boolean {
  for (let offset = index + 1; offset < index + words; offset += 1) {
    if (!PHRASE_GAP.test(text.slice(tokens[offset - 1]!.end, tokens[offset]!.start))) return false;
  }
  return true;
}

function isInsideIdentifier(text: string, start: number, end: number): boolean {
  CONTINUES_AFTER.lastIndex = end;
  if (CONTINUES_AFTER.test(text)) return true;
  return /[._/]/u.test(text[start - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[start - 2] ?? "");
}

function joinPrefix(prefix: string, written: string): string {
  if (!prefix) return written;
  return /^[A-Za-z0-9.~]/u.test(written) ? `${prefix}־${written}` : `${prefix}${written}`;
}

/** Replaces in one pass from the longest phrase down, so a replacement is never replaced again. */
export function applyTerms(text: string, matcher: TermMatcher, shape: (written: string) => string = (written) => written): string {
  if (matcher.terms.size === 0 || !text) return text;

  const tokens = tokenize(text);
  let result = "";
  let copiedUpTo = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const start = tokens[index]!.start;
    for (let words = Math.min(matcher.maxWords, tokens.length - index); words >= 1; words -= 1) {
      const found = findTerm(tokens, index, words, matcher);
      if (!found) continue;

      const end = tokens[index + words - 1]!.end;
      if (!phraseIsContinuous(text, tokens, index, words) || isInsideIdentifier(text, start, end)) continue;

      const prefix = text.slice(start, start + found.prefixLength);
      result += text.slice(copiedUpTo, start) + shape(joinPrefix(prefix, found.term.written));
      copiedUpTo = end;
      index += words - 1;
      break;
    }
  }

  return copiedUpTo === 0 ? text : result + text.slice(copiedUpTo);
}
