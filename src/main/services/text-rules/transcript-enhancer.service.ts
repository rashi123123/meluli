import type { TranscriptSegment } from "@shared/types";
import { applyHebrewNumbers, isDigitWord } from "./hebrew-numbers";
import { textWithPauses } from "./pause-punctuation";
import { applySelfCorrections } from "./self-corrections";
import { applySpokenCommands, resolveSpokenBreaks, SPOKEN_LINE_BREAK, SPOKEN_PARAGRAPH_BREAK } from "./spoken-commands";
import { applySpokenContacts } from "./spoken-contacts";
import { applySpokenLists, resolveListNumbers } from "./spoken-lists";
import { applyTerms, termSpelledBy, type TermMatcher } from "./term-replacement";
import { bare } from "./hebrew-tokens";

// Holds the spaces of a corrected term through the sentence split, which breaks on any whitespace.
const TERM_SPACE = "\uE000";

const QUESTION_WORDS = new Set(["איך", "למה", "מתי", "איפה", "מי", "מה", "האם", "כמה", "איזה", "איזו"]);
/** Sure enough to turn the model's period into a question mark. כמה is also "a few" and איזה also "what a". */
const CLEAR_QUESTION_WORDS = new Set(["האם", "למה", "איך", "מתי", "איפה", "מדוע", "היכן", "לאן", "מאיפה", "מי", "מה"]);
/** Words that may open a question before the question word: "אז למה", "אבל איך". */
const QUESTION_LEAD_INS = new Set(["אז", "אבל", "רגע", "טוב", "ו", "וגם", "ובכן"]);
const QUESTION_TAGS = [/,\s*נכון$/u, /,\s*לא$/u, /,\s*כן$/u, /(?:^|\s)מה\s+(?:דעתך|דעתכם|דעתכן|את\s+אומרת|אתה\s+אומר|אתם\s+אומרים)$/u];
/** "והוא אמר, לא" reports an answer. */
const REPORTED_ANSWER = /(?:^|\s)ו?(?:אמר|אמרה|אמרו|אמרתי|אמרנו|ענה|ענתה|ענו|עניתי|השיב|השיבה),\s*(?:לא|נכון|כן)$/u;
/** "הבנתי, כן", "בסדר, כן": an answer that agrees, not a tag question. */
const AGREEING_YES = /^(?:(?:אז|טוב|אוקיי|כן),?\s+)?(?:הבנתי|הבנו|בסדר|אוקיי|אוקי|טוב|כן|נכון|ברור|יופי|סבבה|מעולה|אחלה|בדיוק),\s*כן$/u;
/** Words after a question word that open with ש but are no ש clause: "מה שלומך", "מי שלח". */
const NOT_A_CLAUSE = /^(?:שלום|שלומ\p{L}+|שמך|שמו|שמה|שמכם|שמכן|שעה|שמעת|שמעתם|שמעתן|שאלת|שאלתם|שמת|שמתם|שלח|שלחה|שלחו|שלחת|שלחתם|שכחת|שכחתם)$/u;
/** After such a clause a predicate makes it a subject: "מה שמעת זה לא נכון", "מי שלח את הטופס יקבל תשובה". */
const PREDICATE_PRONOUNS = new Set(["זה", "זאת", "זו", "הוא", "היא", "הם", "הן"]);
const PREPOSITIONS = new Set(["את", "על", "עם", "של", "אל", "בלי", "כמו", "מול", "אחרי", "לפני", "בגלל", "עד", "מן", "לגבי", "בשביל", "אצל"]);
const FUTURE_VERB = /^[יתנ]\p{L}{3,4}$/u;
const NOT_FUTURE_VERBS = new Set([
  "יותר", "ילדים", "ילדה", "ימים", "ישראל", "ינואר", "יחסים", "ירוק", "ירוקה", "יפים", "יפות", "ישיבה", "יכולת",
  "תמיד", "תודה", "תוכנית", "תשובה", "תמונה", "תקופה", "תוצאה", "תחנה", "תיק", "תיקים", "תאריך", "תפקיד", "תנאי", "תהליך",
  "נכון", "נושא", "נקודה", "נסיעה", "נתונים"
]);
/** A greeting, a name or a lead-in before a comma may open a question: "סליחה, איפה", "דני, מתי". */
const COMMA_LEAD_WORDS = 2;
/** After a comma, כמה and איזה are more often "how many" and "what a" than a question. */
const NOT_AFTER_COMMA = new Set(["כמה", "איזה", "איזו"]);
/** "אני לא יודע, מה לעשות" is an indirect question, and "וואו, איזה יופי" an exclamation. */
const NO_QUESTION_BEFORE_COMMA = new Set([
  "יודע", "יודעת", "יודעים", "מושג", "בטוח", "בטוחה", "בטוחים", "זוכר", "זוכרת", "זוכרים", "ברור", "מבין", "מבינה", "מבינים",
  "וואו", "ואו", "וואי", "ואי", "אוי", "איזה", "אוף", "וואלה", "אח"
]);
/** Words a speaker says twice on purpose: "לאט לאט", "יום יום". */
const DOUBLED_WORDS = new Set(["לאט", "יום", "פעם", "קצת", "יחד", "צעד", "מעט", "טיפה"]);
/** A sentence is split at a good place after this many words, and anywhere after the hard limit. */
const SOFT_SENTENCE_WORDS = 18;
const HARD_SENTENCE_WORDS = 30;
const CONTRAST_WORDS = new Set(["אבל", "אלא"]);
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
  /** Spoken numbers become digits. On unless the person turns it off. */
  numbersAsDigits?: boolean;
  terms?: TermMatcher;
  /** Dictation only: spoken punctuation, "סליחה" corrections and spoken lists. */
  spokenCommands?: boolean;
  /** The model's timed segments. Their pauses end sentences and paragraphs. */
  segments?: readonly TranscriptSegment[] | null;
}

export interface EnhancedTranscriptResult {
  rawText: string;
  text: string;
  paragraphs: string[];
  possibleTerms: string[];
  uncertainSegments: string[];
}

function normalizeForComparison(token: string): string {
  return bare(token)
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

/** A mark after a word ends what the speaker said there, so the next word is no stutter. */
const endsWithMark = (token: string | undefined) => /[,.;:!?]["')\]]*$/u.test(token ?? "");

/** One digit said as a word or written, as in a phone number read out digit by digit. */
const isDigit = (word: string) => isDigitWord(word) || /^\d$/u.test(word);

/**
 * Doubled idioms, a digit inside a number read digit by digit ("שבע שבע שבע", next to another digit),
 * and a term spelled with a doubled word ("איי איי") are meant twice. "שלוש שלוש בעיות" is a stutter.
 */
function meantTwice(tokens: readonly string[], index: number, terms: TermMatcher | undefined): boolean {
  const word = normalizeForComparison(tokens[index]!);
  if (DOUBLED_WORDS.has(word)) return true;
  if (isDigit(word) && [tokens[index - 2], tokens[index + 1]].some((token) => token !== undefined && isDigit(normalizeForComparison(token)))) return true;
  return terms !== undefined && termSpelledBy(terms, tokens.slice(index - 1).map(normalizeForComparison));
}

function removeRepeatedPhrases(tokens: string[]): string[] {
  const cleaned: string[] = [];
  for (const token of tokens) {
    cleaned.push(token);
    for (const size of [3, 2]) {
      const end = cleaned.length;
      if (end < size * 2) continue;
      const first = cleaned.slice(end - size - size, end - size);
      const repeated = !endsWithMark(first.at(-1)) && first.every((word, offset) =>
        normalizeForComparison(word) === normalizeForComparison(cleaned[end - size + offset]!));
      // "אחת שתיים אחת שתיים" inside a phone number is read that way.
      if (repeated && !first.every((word) => isDigit(normalizeForComparison(word)))) {
        cleaned.splice(end - size, size);
        break;
      }
    }
  }
  return cleaned;
}

function removeFillersAndImmediateRepeats(text: string, terms?: TermMatcher): string {
  const tokens = text.split(/\s+/u).filter(Boolean);
  const cleaned: string[] = [];
  let previousComparable = "";

  for (const [index, token] of tokens.entries()) {
    if (isFillerWord(token) || isPausedFiller(token, cleaned.at(-1), tokens[index + 1])) {
      moveEnding(token, cleaned);
      continue;
    }

    const comparable = normalizeForComparison(token);
    if (comparable && comparable === previousComparable && !endsWithMark(cleaned.at(-1)) && !meantTwice(tokens, index, terms)) {
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
    // A Hebrew prefix on a Latin word takes a maqaf, as the term rules write it: "ב-Jira" is "ב־Jira".
    .replace(/(?<![\p{L}\p{N}])([ובכלמהש]{1,3})-(?=[A-Za-z])/gu, "$1־")
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

function opensWithQuestion(sentence: string, words: ReadonlySet<string>): boolean {
  const raw = sentence.split(/\s+/u).filter(Boolean);
  const tokens = raw.map(normalizeForComparison);
  const skipLeadIns = (start: number) => {
    let index = start;
    while (index < tokens.length - 1 && QUESTION_LEAD_INS.has(tokens[index]!)) index += 1;
    return index;
  };
  const isQuestionWord = (token: string) => words.has(token) || (token.startsWith("ו") && words.has(token.slice(1)));
  let index = skipLeadIns(0);
  if (!isQuestionWord(tokens[index] ?? "")) {
    // "סליחה, איפה התחנה", "דני, מתי אתה מגיע": a greeting or a name before a comma.
    const comma = raw.slice(0, COMMA_LEAD_WORDS).findIndex((token) => /,$/u.test(token));
    if (comma < 0 || tokens.slice(0, comma + 1).some((token) => NO_QUESTION_BEFORE_COMMA.has(token))) return false;
    index = skipLeadIns(comma + 1);
    const token = tokens[index] ?? "";
    if (!isQuestionWord(token) || NOT_AFTER_COMMA.has(token.replace(/^ו/u, ""))) return false;
  }
  // "מה שחשוב", "איך שהוא הגיע": a ש word right after makes it a clause, not a question.
  const next = tokens[index + 1] ?? "";
  if (!next.startsWith("ש")) return true;
  return NOT_A_CLAUSE.test(next) && !tokens.some((_, at) => at > index + 1 && isPredicate(tokens, at));
}

/** A word that gives a ש clause its own predicate, so the clause is a subject, not a question. "על זה" is no predicate. */
function isPredicate(tokens: readonly string[], index: number): boolean {
  const token = tokens[index]!;
  if (PREPOSITIONS.has(tokens[index - 1] ?? "")) return false;
  return PREDICATE_PRONOUNS.has(token) || (FUTURE_VERB.test(token) && !NOT_FUTURE_VERBS.has(token));
}

function endsWithQuestionTag(sentence: string): boolean {
  const body = sentence.replace(/[.!?…]+$/u, "").trim();
  return !REPORTED_ANSWER.test(body) && !AGREEING_YES.test(body) && QUESTION_TAGS.some((tag) => tag.test(body));
}

function chooseSentenceEnding(sentence: string): string {
  return opensWithQuestion(sentence, QUESTION_WORDS) || endsWithQuestionTag(sentence) ? "?" : ".";
}

/** A comma before אבל and אלא, the one Hebrew comma speech models most often leave out. */
function addContrastCommas(sentence: string): string {
  const tokens = sentence.split(" ");
  for (let index = 2; index < tokens.length; index += 1) {
    if (!CONTRAST_WORDS.has(tokens[index]!)) continue;
    const previous = tokens[index - 1]!;
    if (/[\p{L}\p{N}"')]$/u.test(previous) && !/^[A-Za-z]/u.test(previous)) tokens[index - 1] = `${previous},`;
  }
  return tokens.join(" ");
}

/** Hebrew rules over a sentence the model or the split already ended. "!" and an existing "?" stay. */
function refineHebrewSentence(sentence: string): string {
  let refined = addContrastCommas(sentence);
  const question = opensWithQuestion(refined, CLEAR_QUESTION_WORDS) || endsWithQuestionTag(refined);
  if (!question) return refined;
  if (/\.$/u.test(refined) && !/\.\.$/u.test(refined)) refined = `${refined.slice(0, -1)}?`;
  else if (/[\p{L}\p{N}"')]$/u.test(refined)) refined = `${refined}?`;
  return refined;
}

function sentenceStarter(token: string): boolean {
  return TOPIC_SHIFT_WORDS.has(normalizeForComparison(token));
}

function splitIntoSeedSentences(text: string): string[] {
  if (!text.trim()) {
    return [];
  }

  if (!needsPunctuationRestoration(text)) {
    const sentences = text
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    // Only the last one can be open, when the model stopped before its period.
    const last = sentences.at(-1);
    if (last && /[\p{L}\p{N}"')]$/u.test(last)) sentences[sentences.length - 1] = `${last}${chooseSentenceEnding(last)}`;
    return sentences;
  }

  const tokens = text.split(/\s+/u).filter(Boolean);
  const sentences: string[] = [];
  let current: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    current.push(tokens[index]!);
    const nextToken = tokens[index + 1] ?? "";
    const currentSize = current.length;
    const shouldBreak =
      /[.!?]$/u.test(current.at(-1) ?? "") ||
      currentSize >= HARD_SENTENCE_WORDS ||
      (currentSize >= SOFT_SENTENCE_WORDS && nextToken === "אז") ||
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
    // A colon opens a list, so it keeps its place at the end.
    .map((sentence) => /:$/u.test(sentence) ? sentence : `${sentence.replace(/[.!?]+$/u, "").trim()}${chooseSentenceEnding(sentence)}`);
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
    const token = bare(match[0]);
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

/** Punctuation with no words before it, at the start of the text or of a dictated line. */
const LEADING_MARKS = /^[\s,;:.!?،]+/u;

export function enhanceTranscript(rawText: string, options: EnhanceTranscriptOptions): EnhancedTranscriptResult {
  const normalizedRawText = normalizeSpacingAndPunctuation(rawText);
  const possibleTerms = extractPossibleTerms(normalizedRawText);

  let workingText = textWithPauses(normalizedRawText, options.segments, { spokenCommands: options.spokenCommands }) ?? normalizedRawText;
  if (options.removeFillerWords) {
    workingText = removeFillersAndImmediateRepeats(workingText, options.terms);
  }

  workingText = normalizeSpacingAndPunctuation(workingText);
  if (options.terms) {
    workingText = applyTerms(workingText, options.terms, (written) => written.replaceAll(" ", TERM_SPACE));
  }
  // Before numbers and spoken commands, which would read "אפס חמש" or "נקודה קום" their own way.
  workingText = applySpokenContacts(workingText);
  // Before spoken commands, so "שתיים נקודה חמש" is still a number when נקודה would become a period.
  if (options.numbersAsDigits !== false) workingText = applyHebrewNumbers(workingText);
  if (options.spokenCommands) {
    const corrected = applySelfCorrections(workingText);
    // A correction may leave number words the first pass could not read: "בשעה חמש וחצי" after "בשעה 3:30".
    workingText = corrected !== workingText && options.numbersAsDigits !== false ? applyHebrewNumbers(corrected) : corrected;
    workingText = applySpokenLists(applySpokenCommands(workingText));
  }

  // Each spoken break closes its own block, so the sentence split cannot merge across it.
  const blocks = workingText.split(new RegExp(`([${SPOKEN_LINE_BREAK}${SPOKEN_PARAGRAPH_BREAK}])`, "u"));
  const paragraphs: string[] = [];
  let joined = "";
  for (const block of blocks) {
    if (block === SPOKEN_LINE_BREAK || block === SPOKEN_PARAGRAPH_BREAK) {
      joined += block;
      continue;
    }
    // Whisper sometimes opens with a mark, such as ", " for a breath before the first word.
    const sentences = splitIntoSeedSentences(block.replace(LEADING_MARKS, ""))
      .map((sentence) => refineHebrewSentence(normalizeSpacingAndPunctuation(sentence)).replaceAll(TERM_SPACE, " "));
    const blockParagraphs = paragraphizeSentences(sentences);
    paragraphs.push(...blockParagraphs.map(resolveListNumbers));
    joined += blockParagraphs.join("\n\n");
  }
  const cleanText = resolveListNumbers(resolveSpokenBreaks(joined));
  const uncertainSegments = detectUncertainSegments(cleanText);

  return {
    rawText,
    text: cleanText,
    paragraphs,
    possibleTerms,
    uncertainSegments
  };
}
