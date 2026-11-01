import type { AppSettings } from "@shared/types";
import { BUILT_IN_ENTRIES, NOT_PREFIXED } from "./term-lexicon";

export interface TermEntry {
  heard: string;
  written: string;
}

interface CompiledTerm {
  written: string;
  /** A short phrase after a stripped letter is too likely to be another Hebrew word. */
  takesPrefix: boolean;
}

export interface TermMatcher {
  terms: Map<string, CompiledTerm>;
  notPrefixed: Set<string>;
  maxWords: number;
}

export interface TermSources {
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

export function buildTermMatcher({ entries, notPrefixed = [] }: TermSources): TermMatcher {
  const terms = new Map<string, CompiledTerm>();
  let maxWords = 0;

  for (const entry of entries) {
    const written = entry.written.trim();
    const words = tokenize(entry.heard).map((token) => token.key);
    const key = words.join(" ");
    if (!key || !written || terms.has(key)) continue;

    const letters = key.replace(/[\s'"]/gu, "").length;
    terms.set(key, { written, takesPrefix: letters >= MIN_PREFIXED_LETTERS });
    maxWords = Math.max(maxWords, words.length);
  }

  return { terms, notPrefixed: new Set(notPrefixed.map(toKey)), maxWords };
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
    const term = matcher.terms.get([first.slice(prefixLength), ...rest].join(" "));
    if (term?.takesPrefix) return { term, prefixLength };
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

let cachedMatcher: { signature: string; matcher: TermMatcher } | null = null;

/** Settings are parsed afresh on every read, so the signature decides whether anything changed. */
export function termMatcherForSettings({ builtInTerms, dictionary }: Pick<AppSettings, "builtInTerms" | "dictionary">): TermMatcher {
  const signature = JSON.stringify([builtInTerms, dictionary]);
  if (cachedMatcher?.signature !== signature) {
    const matcher = buildTermMatcher({
      entries: builtInTerms ? [...dictionary, ...BUILT_IN_ENTRIES] : dictionary,
      notPrefixed: NOT_PREFIXED
    });
    cachedMatcher = { signature, matcher };
  }
  return cachedMatcher.matcher;
}
