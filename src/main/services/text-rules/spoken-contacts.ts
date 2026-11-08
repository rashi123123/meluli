import { splitWords, type Word } from "./hebrew-tokens";

/**
 * Spoken email addresses, web addresses and phone numbers in their written form:
 * "dani שטרודל ג'ימייל נקודה קום" is dani@gmail.com, "אפס חמש ארבע ..." is 054-...
 * Only a Latin name or a known mail domain starts an address, so "שתיים נקודה חמש" stays a number.
 */

const AT_WORDS = new Set(["שטרודל", "כרוכית", "@"]);
const DOT_WORDS = new Set(["נקודה", "דוט"]);
const SLASH_WORDS = new Set(["סלאש", "לוכסן"]);

/** Hebrew spellings of address parts that speech models write in Hebrew letters. */
const ADDRESS_WORDS: Record<string, string> = {
  "ג'ימייל": "gmail", גימייל: "gmail", "ג׳ימייל": "gmail", "ג׳מייל": "gmail", "ג'מייל": "gmail",
  יאהו: "yahoo", הוטמייל: "hotmail", אאוטלוק: "outlook", אוטלוק: "outlook", אייקלאוד: "icloud",
  וואלה: "walla", פרוטון: "proton", פרוטונמייל: "protonmail",
  קום: "com", נט: "net", אורג: "org", קו: "co", איל: "il", אייאו: "io", גוב: "gov", אדו: "edu", אפ: "app", דב: "dev"
};
/** Hebrew words that only end an address, so a Hebrew word cannot start one. */
const DOMAIN_STARTS = new Set(["gmail", "yahoo", "hotmail", "outlook", "icloud", "walla", "proton", "protonmail", "www"]);

const DIGIT_WORDS: Record<string, string> = {
  אפס: "0", אחד: "1", אחת: "1", שתיים: "2", שניים: "2", שתים: "2", שלוש: "3", שלושה: "3", ארבע: "4", ארבעה: "4",
  חמש: "5", חמישה: "5", שש: "6", שישה: "6", שבע: "7", שבעה: "7", שמונה: "8", תשע: "9", תשעה: "9"
};
const PHONE_PREFIX = /^(ו?[בל]|ו)(?=\p{L}{2})/u;

const LATIN_PART = /^[A-Za-z0-9][A-Za-z0-9._%+-]*$/u;

/** The written form of one address part, or null when the word is not one. */
function addressPart(core: string): string | null {
  if (core in ADDRESS_WORDS) return ADDRESS_WORDS[core]!;
  return LATIN_PART.test(core) ? core.toLowerCase() : null;
}

/** Reads "part נקודה part ..." from index. Returns the written domain and the index after it. */
function readDomain(tokens: Word[], start: number): { domain: string; end: number; trailing: string } | null {
  const first = tokens[start];
  if (!first) return null;
  const firstPart = addressPart(first.core);
  if (!firstPart) return null;
  const parts = [firstPart];
  let index = start + 1;
  let trailing = first.trailing;
  while (!trailing && index + 1 < tokens.length && DOT_WORDS.has(tokens[index]!.core) && !tokens[index]!.trailing) {
    const part = addressPart(tokens[index + 1]!.core);
    if (!part) break;
    parts.push(part);
    trailing = tokens[index + 1]!.trailing;
    index += 2;
  }
  // A path: "סלאש" and a Latin word.
  while (!trailing && parts.length > 1 && index + 1 < tokens.length && SLASH_WORDS.has(tokens[index]!.core)) {
    const part = addressPart(tokens[index + 1]!.core);
    if (!part) break;
    parts[parts.length - 1] += `/${part}`;
    trailing = tokens[index + 1]!.trailing;
    index += 2;
  }
  return { domain: parts.join("."), end: index, trailing };
}

const isTld = (part: string) => /^[a-z]{2,6}$/u.test(part);

function readEmail(tokens: Word[], index: number): { text: string; end: number } | null {
  const local = tokens[index]!;
  const at = tokens[index + 1];
  if (!at || local.trailing || at.trailing || !AT_WORDS.has(at.core)) return null;
  if (!LATIN_PART.test(local.core)) return null;
  const domain = readDomain(tokens, index + 2);
  if (!domain || !domain.domain.includes(".") || !isTld(domain.domain.split(".").at(-1)!)) return null;
  return { text: `${local.core.toLowerCase()}@${domain.domain}${domain.trailing}`, end: domain.end };
}

function readWebAddress(tokens: Word[], index: number): { text: string; end: number } | null {
  const first = tokens[index]!;
  const firstPart = addressPart(first.core);
  // A Latin name or www opens a web address; a Hebrew word never does.
  if (!firstPart || !(LATIN_PART.test(first.core) || DOMAIN_STARTS.has(firstPart))) return null;
  if (first.core.includes(".")) return null;
  const domain = readDomain(tokens, index);
  if (!domain || domain.end === index + 1) return null;
  const parts = domain.domain.split("/")[0]!.split(".");
  if (!isTld(parts.at(-1)!) || !(parts.at(-1)! in TLDS)) return null;
  return { text: `${domain.domain}${domain.trailing}`, end: domain.end };
}

const TLDS: Record<string, true> = Object.fromEntries(
  ["com", "net", "org", "co", "il", "io", "gov", "edu", "app", "dev", "ai", "me", "info", "biz", "us", "uk"].map((tld) => [tld, true])
);

function formatPhone(digits: string): string {
  if (/^05\d{8}$/u.test(digits) || /^07\d{8}$/u.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (/^0[2-9]\d{7}$/u.test(digits)) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  if (/^9725\d{8}$/u.test(digits)) return `+972-${digits.slice(3, 5)}-${digits.slice(5)}`;
  return digits;
}

/** Nine or more digits said one by one, starting with אפס or with פלוס. Anything shorter is just numbers. */
function readPhone(tokens: Word[], index: number): { text: string; end: number } | null {
  let cursor = index;
  let digits = "";
  let prefix = "";
  let trailing = "";
  if (tokens[cursor]!.core === "פלוס") cursor += 1;

  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    let core = token.core;
    if (cursor === index) {
      const match = core.match(PHONE_PREFIX);
      if (match && core.slice(match[0].length) in DIGIT_WORDS) {
        prefix = match[0];
        core = core.slice(match[0].length);
      }
    }
    const digit = DIGIT_WORDS[core] ?? (/^\d{1,4}$/u.test(core) ? core : null);
    if (digit === null) break;
    digits += digit;
    trailing = token.trailing;
    cursor += 1;
    // A comma between groups is how people pause in a number; anything else ends it.
    if (trailing && trailing !== ",") break;
  }

  const plus = tokens[index]!.core === "פלוס";
  if (plus ? !digits.startsWith("972") : !digits.startsWith("0")) return null;
  // "פלוס תשע שבע שתיים אפס חמש ארבע ...": the trunk 0 after 972 is not part of the number.
  if (plus) digits = `972${digits.slice(3).replace(/^0/u, "")}`;
  if (digits.length < 9 || digits.length > 12) return null;
  // Only digits said as words count, or a model that wrote 054 and then words.
  const wordCount = tokens.slice(index, cursor).filter((token) => !/^\d/u.test(token.core)).length;
  if (wordCount < 5) return null;
  const formatted = formatPhone(digits);
  const written = prefix ? `${prefix}-${formatted}` : formatted;
  return { text: `${written}${trailing}`, end: cursor };
}

export function applySpokenContacts(text: string): string {
  if (!text) return text;
  const { words: tokens, spaceAfter } = splitWords(text);
  let result = "";
  let index = 0;

  while (index < tokens.length) {
    const found = readEmail(tokens, index) ?? readPhone(tokens, index) ?? readWebAddress(tokens, index);
    if (found) {
      // "ל dani@gmail.com": a lone prefix letter joins the address.
      const lonePrefix = index > 0 && /^ו?[לבמש]$/u.test(tokens[index - 1]!.core) && !tokens[index - 1]!.trailing;
      if (lonePrefix) result = `${result.trimEnd()}-`;
      result += found.text + spaceAfter(found.end - 1);
      index = found.end;
      continue;
    }
    result += tokens[index]!.raw + spaceAfter(index);
    index += 1;
  }
  return result;
}
