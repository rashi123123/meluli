import { HEBREW_MONTHS, splitWords, type Word } from "./hebrew-tokens";

/**
 * Spoken Hebrew numbers to digits. The model already writes years, dates and decimals in digits,
 * so this only catches what it leaves in words, and it stays out of anything ambiguous:
 * a lone number up to ten, or a lone מאה or אלף, is a word unless a percent, a month or a time says otherwise.
 */

const UNITS: Record<string, number> = {
  אחד: 1, אחת: 1,
  // שנים is also "years", so it only counts as two before עשר: שנים עשר.
  שניים: 2, שתיים: 2, שני: 2, שתי: 2, שתים: 2,
  שלוש: 3, שלושה: 3, שלושת: 3,
  ארבע: 4, ארבעה: 4, ארבעת: 4,
  חמש: 5, חמישה: 5, חמשת: 5,
  שש: 6, שישה: 6, ששת: 6,
  שבע: 7, שבעה: 7, שבעת: 7,
  שמונה: 8, שמונת: 8,
  תשע: 9, תשעה: 9, תשעת: 9,
  עשר: 10, עשרה: 10, עשרת: 10
};
const TENS: Record<string, number> = {
  עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, שישים: 60, שבעים: 70, שמונים: 80, תשעים: 90
};
const HUNDREDS: Record<string, number> = { מאה: 100, מאתיים: 200 };
const THOUSANDS: Record<string, number> = { אלף: 1_000, אלפיים: 2_000 };
const SCALES: Record<string, number> = { אלף: 1_000, אלפים: 1_000, מיליון: 1_000_000, מיליארד: 1_000_000_000 };
const TEEN_TEN = new Set(["עשר", "עשרה"]);
/** Hebrew writes these as words even in a long number, so on their own they never become digits. */
const ROUND_WORDS = new Set(["מאה", "מאתיים", "אלף", "אלפיים", "מיליון", "מיליארד"]);

const PERCENT = new Set(["אחוז", "אחוזים"]);
const TIME_CUES = new Set(["בשעה", "שעה", "בשעות", "השעה"]);
const MINUTE_WORDS: Record<string, number> = { וחצי: 30, ורבע: 15 };
const DIGIT_WORDS: Record<string, number> = { אפס: 0, ...Object.fromEntries(Object.entries(UNITS).filter(([, value]) => value < 10)) };

// A word may carry one of these before it, as ב in בעשרים. ה is left out: העשרים is "the twenties".
const FIRST_PREFIXES = /^(ו?[בלמכ]|ו)(?=\p{L}{2})/u;

interface ParsedNumber {
  value: number;
  /** Index after the last token used. */
  end: number;
  prefix: string;
  words: number;
  roundOnly: boolean;
}

const isNumberWord = (word: string) =>
  word in UNITS || word in TENS || word in HUNDREDS || word in SCALES || word in THOUSANDS || word === "מאות";

/** A number said in words or digits, which a speaker may repeat on purpose: "שבע שבע שבע" in a phone number. */
export const isSpokenNumber = (word: string): boolean => /^\d/u.test(word) || word === "אפס" || isNumberWord(word);

/** One digit said as a word, אפס to תשע, as a phone number is read out: "שבע שבע שבע". */
export const isDigitWord = (word: string): boolean => Object.hasOwn(DIGIT_WORDS, word);

function stripPrefix(word: string, first: boolean): { prefix: string; word: string } {
  if (isNumberWord(word)) return { prefix: "", word };
  const match = first ? word.match(FIRST_PREFIXES) : word.match(/^ו(?=\p{L}{2})/u);
  if (match && isNumberWord(word.slice(match[0].length))) return { prefix: match[0], word: word.slice(match[0].length) };
  return { prefix: "", word };
}

/** Reads one number from tokens[start], largest part first, the way Hebrew says it. */
function parseNumber(words: Word[], start: number): ParsedNumber | null {
  let total = 0;
  let group = 0;
  let lastRank = Infinity;
  let lastScale = Infinity;
  let index = start;
  let prefix = "";
  let used = 0;
  let roundOnly = true;

  while (index < words.length) {
    const first = index === start;
    // Punctuation inside the number ends it: "עשרים, שלושים" is two numbers.
    if (!first && words[index - 1]!.trailing) break;
    const stripped = stripPrefix(words[index]!.core, first);
    const word = stripped.word;
    const next = words[index + 1]?.core;
    const nextFree = !words[index]!.trailing;
    let rank: number;
    let value: number;
    let consumed = 1;
    const teen = nextFree && next !== undefined && TEEN_TEN.has(next);

    if ((word in UNITS || word === "שנים") && teen && (UNITS[word] ?? 2) < 10) {
      rank = 1; value = 10 + (UNITS[word] ?? 2); consumed = 2;
    } else if (word in UNITS && nextFree && next === "מאות" && UNITS[word]! >= 3 && UNITS[word]! <= 9) {
      rank = 3; value = UNITS[word]! * 100; consumed = 2;
    } else if (word in UNITS && nextFree && next === "אלפים" && UNITS[word]! >= 3) {
      if (lastScale <= 1_000) break;
      total += (group + UNITS[word]!) * 1_000;
      group = 0; lastRank = Infinity; lastScale = 1_000;
      if (first) prefix = stripped.prefix;
      index += 2; used += 2; roundOnly = false;
      continue;
    } else if (word in UNITS) {
      rank = 1; value = UNITS[word]!;
    } else if (word in TENS) {
      rank = 2; value = TENS[word]!;
    } else if (word in HUNDREDS) {
      rank = 3; value = HUNDREDS[word]!;
    } else if (word in THOUSANDS && group === 0 && lastScale > 1_000) {
      total += THOUSANDS[word]!;
      lastRank = Infinity; lastScale = 1_000;
      if (first) prefix = stripped.prefix;
      index += 1; used += 1;
      continue;
    } else if (word in SCALES && word !== "אלפים" && (group > 0 || total > 0) && SCALES[word]! < lastScale && !first) {
      const scale = SCALES[word]!;
      total += (group || 1) * scale;
      group = 0; lastRank = Infinity; lastScale = scale;
      index += 1; used += 1;
      continue;
    } else if ((word === "מיליון" || word === "מיליארד") && first) {
      total += SCALES[word]!;
      lastRank = Infinity; lastScale = SCALES[word]!;
      prefix = stripped.prefix;
      index += 1; used += 1;
      continue;
    } else {
      break;
    }

    if (rank >= lastRank) break;
    if (!ROUND_WORDS.has(word) || consumed > 1) roundOnly = false;
    if (first) prefix = stripped.prefix;
    group += value;
    lastRank = rank;
    index += consumed;
    used += consumed;
  }

  if (used === 0) return null;
  return { value: total + group, end: index, prefix, words: used, roundOnly };
}

/** 2 מיליון reads better than 2,000,000, and a year never takes a thousands comma. */
function formatNumber(value: number): string {
  if (value >= 1_000_000_000 && value % 1_000_000_000 === 0) return `${value / 1_000_000_000} מיליארד`;
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000} מיליון`;
  return value >= 10_000 ? value.toLocaleString("en-US") : String(value);
}

const joinPrefix = (prefix: string, digits: string) => (prefix ? `${prefix}-${digits}` : digits);

function previousIsNumber(words: Word[], index: number): boolean {
  const previous = words[index - 1];
  if (!previous || previous.trailing) return false;
  return /\d$/u.test(previous.core) || isNumberWord(stripPrefix(previous.core, true).word);
}

export function applyHebrewNumbers(text: string): string {
  if (!text) return text;
  const { words, spaceAfter } = splitWords(text);
  let result = "";
  let index = 0;

  const emit = (value: string, end: number) => {
    result += value + spaceAfter(end - 1);
    index = end;
  };

  while (index < words.length) {
    const word = words[index]!;
    // "שמונה ועשרים" is eight-twenty, not eight and a separate 20.
    const continuesNumber = stripPrefix(word.core, true).prefix.startsWith("ו") && previousIsNumber(words, index);
    const parsed = continuesNumber ? null : parseNumber(words, index);
    if (!parsed) {
      emit(word.raw, index + 1);
      continue;
    }

    const last = words[parsed.end - 1]!;
    const following = parsed.end < words.length && !last.trailing ? words[parsed.end] : undefined;
    const before = words[index - 1];
    const digits = formatNumber(parsed.value);

    // 2.5: a whole number, the word נקודה, and digit words after it.
    if (following?.core === "נקודה" && !following.trailing && parsed.value < 1_000) {
      const decimals: number[] = [];
      let cursor = parsed.end + 1;
      while (cursor < words.length && words[cursor]!.core in DIGIT_WORDS) {
        decimals.push(DIGIT_WORDS[words[cursor]!.core]!);
        cursor += 1;
        if (words[cursor - 1]!.trailing) break;
      }
      if (decimals.length > 0) {
        const decimal = `${digits}.${decimals.join("")}`;
        const percent = !words[cursor - 1]!.trailing && cursor < words.length && PERCENT.has(words[cursor]!.core);
        if (percent) emit(joinPrefix(parsed.prefix, `${decimal}%`) + words[cursor]!.trailing, cursor + 1);
        else emit(joinPrefix(parsed.prefix, decimal) + words[cursor - 1]!.trailing, cursor);
        continue;
      }
    }

    if (following && PERCENT.has(following.core)) {
      emit(joinPrefix(parsed.prefix, `${digits}%`) + following.trailing, parsed.end + 1);
      continue;
    }

    if (following && parsed.value >= 1 && parsed.value <= 31 && following.core.startsWith("ב") && HEBREW_MONTHS.has(following.core.slice(1))) {
      emit(joinPrefix(parsed.prefix, digits) + last.trailing, parsed.end);
      continue;
    }

    if (before && !before.trailing && TIME_CUES.has(before.core) && !parsed.prefix && parsed.value >= 1 && parsed.value <= 24) {
      let minutes = 0;
      let end = parsed.end;
      let trailing = last.trailing;
      if (following && following.core in MINUTE_WORDS) {
        minutes = MINUTE_WORDS[following.core]!;
        end += 1;
        trailing = following.trailing;
      } else if (following?.core.startsWith("ו")) {
        const minute = parseNumber(words, parsed.end);
        if (minute && minute.prefix === "ו" && minute.value >= 1 && minute.value <= 59) {
          minutes = minute.value;
          end = minute.end;
          trailing = words[minute.end - 1]!.trailing;
        }
      }
      emit(`${parsed.value}:${String(minutes).padStart(2, "0")}${trailing}`, end);
      continue;
    }

    const wordOnItsOwn = parsed.words === 1 && (parsed.value <= 10 || parsed.roundOnly);
    if (parsed.value >= 11 && !wordOnItsOwn) {
      emit(joinPrefix(parsed.prefix, digits) + last.trailing, parsed.end);
      continue;
    }

    emit(word.raw, index + 1);
  }

  return result;
}
