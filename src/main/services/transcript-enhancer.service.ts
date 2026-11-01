import { applySpokenCommands, resolveSpokenBreaks, SPOKEN_LINE_BREAK, SPOKEN_PARAGRAPH_BREAK } from "./spoken-commands";
import { applyTerms, type TermMatcher } from "./term-replacement";

// Holds the spaces of a corrected term through the sentence split, which breaks on any whitespace.
const TERM_SPACE = "\uE000";

const QUESTION_WORDS = new Set(["איך", "למה", "מתי", "איפה", "מי", "מה", "האם", "כמה", "איזה", "איזו"]);
const TOPIC_SHIFT_WORDS = new Set([
  "אבל",
  "עכשיו",
  "בנוסף",
  "לסיכום",
  "בקיצור",
  "בינתיים",
  "ואז",
  "אחר",
  "אחר־כך",
  "אחר-כך",
  "מצד",
  "בכלל",
  "דרך"
]);

export interface EnhanceTranscriptOptions {
  removeFillerWords: boolean;
  terms?: TermMatcher;
  spokenCommands?: boolean;
}

export interface EnhancedTranscriptResult {
  rawText: string;
  text: string;
  paragraphs: string[];
  possibleTerms: string[];
  uncertainSegments: string[];
}

function normalizeForComparison(token: string): string {
  return token
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/["'״׳]/gu, "")
    .toLowerCase();
}

function isFillerWord(token: string): boolean {
  const normalized = normalizeForComparison(token);
  return /^(?:אה+|אמ+|אממ+|אמממ+|המ+|הממ+|אהם+|מ{2,}|יעני)$/u.test(normalized);
}

/** These are real words, so they only count as fillers where the speaker paused around them. */
function isPausedFiller(token: string, previous: string | undefined, next: string | undefined): boolean {
  const word = normalizeForComparison(token);
  if (word !== "כאילו" && word !== "נגיד") return false;
  const pausedAfter = /[,.!?]$/u.test(token);
  const pausedBefore = previous === undefined || /[,.!?]$/u.test(previous);
  if (word === "נגיד") return pausedBefore && pausedAfter;
  return pausedAfter || (next === undefined && previous !== undefined);
}

/** A sentence ending must survive the word it was attached to. */
function moveEnding(token: string, cleaned: string[]): void {
  const ending = token.match(/[.!?]+$/u)?.[0];
  const last = cleaned.at(-1);
  if (ending && last && !/[.!?]$/u.test(last)) cleaned[cleaned.length - 1] = `${last.replace(/[,;:]$/u, "")}${ending}`;
}

function removeRepeatedPhrases(tokens: string[]): string[] {
  const cleaned: string[] = [];
  for (const token of tokens) {
    cleaned.push(token);
    for (const size of [3, 2]) {
      const end = cleaned.length;
      if (end < size * 2) continue;
      const repeated = Array.from({ length: size }, (_, offset) => offset).every((offset) =>
        normalizeForComparison(cleaned[end - size - size + offset]!) === normalizeForComparison(cleaned[end - size + offset]!));
      if (repeated && !/\d/u.test(token)) {
        cleaned.splice(end - size, size);
        break;
      }
    }
  }
  return cleaned;
}

function removeFillersAndImmediateRepeats(text: string): string {
  const tokens = text.split(/\s+/u).filter(Boolean);
  const cleaned: string[] = [];
  let previousComparable = "";

  for (const [index, token] of tokens.entries()) {
    if (isFillerWord(token) || isPausedFiller(token, cleaned.at(-1), tokens[index + 1])) {
      moveEnding(token, cleaned);
      continue;
    }

    const comparable = normalizeForComparison(token);
    if (comparable && comparable === previousComparable) {
      continue;
    }

    cleaned.push(token);
    previousComparable = comparable;
  }

  return removeRepeatedPhrases(cleaned).join(" ");
}

/** File names, hosts, paths and queries carry punctuation that is not a sentence boundary. */
function isTechnicalPunctuation(punctuation: string, value: string, offset: number): boolean {
  const before = value[offset - 1] ?? "";
  const after = value[offset + 1] ?? "";
  const asciiWord = /[A-Za-z0-9]/u;
  if (punctuation === ":" && value.startsWith("//", offset + 1)) return true;
  if (punctuation === "." && asciiWord.test(after) && /[/~\s־]|^$/u.test(before)) return true;
  if (punctuation === "?" && asciiWord.test(after) && /[A-Za-z0-9/]/u.test(before)) return true;
  return (punctuation === "." || punctuation === ":") && asciiWord.test(before) && asciiWord.test(after);
}

function normalizeSpacingAndPunctuation(text: string): string {
  return text
    .replace(/[“”״]/gu, "\"")
    .replace(/[‘’׳]/gu, "'")
    .replace(/(\d)\s*([/:.-])\s*(\d)/gu, "$1$2$3")
    .replace(/(\d)\s*%\b/gu, "$1%")
    .replace(/\s+([,;:!?]|\.(?![A-Za-z]))/gu, "$1")
    .replace(/([,.;:!?])(?![\s"'”)\]]|$)/gu, (punctuation: string, _match: string, offset: number, value: string) => {
      // Decimal points, thousands separators, versions and times are not sentence boundaries.
      const numericSeparator = /[.,:]/u.test(punctuation) &&
        /\d/u.test(value[offset - 1] ?? "") && /\d/u.test(value[offset + 1] ?? "");
      return numericSeparator || isTechnicalPunctuation(punctuation, value, offset) ? punctuation : `${punctuation} `;
    })
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .replace(/\[\s+/gu, "[")
    .replace(/\s+\]/gu, "]")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function needsPunctuationRestoration(text: string): boolean {
  const punctuationCount = (text.match(/[.!?](?=\s|$)/gu) ?? []).length;
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  return punctuationCount === 0 || punctuationCount < Math.max(1, Math.floor(wordCount / 18));
}

function chooseSentenceEnding(sentence: string): string {
  const firstWord = normalizeForComparison(sentence.split(/\s+/u).find(Boolean) ?? "");
  return QUESTION_WORDS.has(firstWord) ? "?" : ".";
}

function sentenceStarter(token: string): boolean {
  return TOPIC_SHIFT_WORDS.has(normalizeForComparison(token));
}

function splitIntoSeedSentences(text: string): string[] {
  if (!text.trim()) {
    return [];
  }

  if (!needsPunctuationRestoration(text)) {
    return text
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }

  const tokens = text.split(/\s+/u).filter(Boolean);
  const sentences: string[] = [];
  let current: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    current.push(tokens[index]!);
    const nextToken = tokens[index + 1] ?? "";
    const currentSize = current.length;
    const shouldBreak =
      currentSize >= 18 ||
      (currentSize >= 10 && nextToken && sentenceStarter(nextToken)) ||
      (currentSize >= 14 && /(?:כן|לא|טוב|בסדר)$/u.test(normalizeForComparison(current.at(-1) ?? "")));

    if (shouldBreak) {
      sentences.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) {
    sentences.push(current.join(" "));
  }

  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => `${sentence.replace(/[.!?]+$/u, "").trim()}${chooseSentenceEnding(sentence)}`);
}

function paragraphizeSentences(sentences: string[]): string[] {
  if (sentences.length === 0) {
    return [];
  }

  const paragraphs: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const wordCount = sentence.split(/\s+/u).filter(Boolean).length;
    const firstWord = normalizeForComparison(sentence.split(/\s+/u).find(Boolean) ?? "");
    const shouldBreak =
      current.length > 0 && (
        currentWordCount + wordCount > 42 ||
        current.length >= 3 ||
        TOPIC_SHIFT_WORDS.has(firstWord)
      );

    if (shouldBreak) {
      paragraphs.push(current.join(" ").trim());
      current = [];
      currentWordCount = 0;
    }

    current.push(sentence.trim());
    currentWordCount += wordCount;
  }

  if (current.length > 0) {
    paragraphs.push(current.join(" ").trim());
  }

  return paragraphs.filter(Boolean);
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

export function extractPossibleTerms(text: string): string[] {
  const terms: string[] = [];

  for (const match of text.matchAll(/["']([^"'“”]{2,48})["']/gu)) {
    terms.push(match[1]!.trim());
  }

  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9+#.&-]{1,}\b/gu)) {
    terms.push(match[0]);
  }

  return uniq(terms).slice(0, 12);
}

export function detectUncertainSegments(text: string): string[] {
  const candidates: string[] = [];

  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!token) {
      continue;
    }

    const hasHebrew = /[\u0590-\u05FF]/u.test(token);
    const hasLatin = /[A-Za-z]/u.test(token);
    const hasDigit = /\d/u.test(token);

    if ((hasHebrew && hasLatin) || (hasHebrew && hasDigit) || token.length > 24 || /(.)\1{3,}/u.test(token)) {
      candidates.push(token);
    }
  }

  return uniq(candidates).slice(0, 8);
}

export function enhanceTranscript(rawText: string, options: EnhanceTranscriptOptions): EnhancedTranscriptResult {
  const normalizedRawText = normalizeSpacingAndPunctuation(rawText);
  const possibleTerms = extractPossibleTerms(normalizedRawText);

  let workingText = normalizedRawText;
  if (options.removeFillerWords) {
    workingText = removeFillersAndImmediateRepeats(workingText);
  }

  workingText = normalizeSpacingAndPunctuation(workingText);
  if (options.terms) {
    workingText = applyTerms(workingText, options.terms, (written) => written.replaceAll(" ", TERM_SPACE));
  }
  if (options.spokenCommands) workingText = applySpokenCommands(workingText);

  // Each spoken break closes its own block, so the sentence split cannot merge across it.
  const blocks = workingText.split(new RegExp(`([${SPOKEN_LINE_BREAK}${SPOKEN_PARAGRAPH_BREAK}])`, "u"));
  const paragraphs: string[] = [];
  let joined = "";
  for (const block of blocks) {
    if (block === SPOKEN_LINE_BREAK || block === SPOKEN_PARAGRAPH_BREAK) {
      joined += block;
      continue;
    }
    const sentences = splitIntoSeedSentences(block)
      .map((sentence) => normalizeSpacingAndPunctuation(sentence).replaceAll(TERM_SPACE, " "));
    const blockParagraphs = paragraphizeSentences(sentences);
    paragraphs.push(...blockParagraphs);
    joined += blockParagraphs.join("\n\n");
  }
  const cleanText = resolveSpokenBreaks(joined);
  const uncertainSegments = detectUncertainSegments(cleanText);

  return {
    rawText,
    text: cleanText,
    paragraphs,
    possibleTerms,
    uncertainSegments
  };
}
