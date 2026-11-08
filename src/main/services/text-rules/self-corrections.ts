import { HEBREW_MONTHS } from "./hebrew-tokens";

/**
 * A spoken correction keeps only what the person meant: "בשלוש, סליחה, בארבע" is "בארבע".
 * It needs an explicit cue and two words of the same kind on either side of it,
 * a number for a number, a day for a day, so an ordinary "סליחה" is never touched.
 */

const CUES: readonly (readonly string[])[] = [["רגע", "לא"], ["לא", "רגע"], ["סליחה"], ["התכוונתי"]];
const LEADS = new Set(["ביום", "יום", "בשעה", "השעה", "שעה", "עד", "מ"]);

const WEEKDAYS = new Set(["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]);
const RELATIVE_DAYS = new Set(["היום", "מחר", "מחרתיים", "אתמול", "שלשום"]);
const NUMBER_WORDS = new Set([
  "אפס", "אחד", "אחת", "שתיים", "שניים", "שתים", "שלוש", "שלושה", "ארבע", "ארבעה", "חמש", "חמישה", "שש", "שישה",
  "שבע", "שבעה", "שמונה", "תשע", "תשעה", "עשר", "עשרה", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים",
  "שמונים", "תשעים", "מאה", "מאתיים", "אלף", "אלפיים"
]);

type Kind = "number" | "weekday" | "day" | "month" | "latin";

const PREFIX = /^(ו?[בלמכ]|ו|ה)(?=.)/u;
const bare = (token: string) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");

function prefixAndStem(token: string): { prefix: string; stem: string } {
  const word = bare(token);
  const match = word.match(PREFIX);
  if (!match) return { prefix: "", stem: word };
  const stem = word.slice(match[0].length).replace(/^-/u, "");
  return kindOfStem(stem) ? { prefix: match[0], stem } : { prefix: "", stem: word };
}

function kindOfStem(stem: string): Kind | null {
  if (/^\d[\d:.,]*%?$/u.test(stem) || NUMBER_WORDS.has(stem)) return "number";
  if (WEEKDAYS.has(stem)) return "weekday";
  if (RELATIVE_DAYS.has(stem)) return "day";
  if (HEBREW_MONTHS.has(stem)) return "month";
  if (/^[A-Za-z][\w.+-]*$/u.test(stem)) return "latin";
  return null;
}

function kindOf(token: string): Kind | null {
  const word = bare(token);
  return kindOfStem(word) ?? kindOfStem(prefixAndStem(token).stem);
}

function cueAt(tokens: string[], index: number): number {
  for (const cue of CUES) {
    if (cue.every((word, offset) => bare(tokens[index + offset] ?? "") === word)) return cue.length;
  }
  return 0;
}

/** The replacement keeps the prefix the person said first: "בשלוש, סליחה, ארבע" is "בארבע". */
function withPrefix(replaced: string, replacement: string): string {
  const before = prefixAndStem(replaced);
  const after = prefixAndStem(replacement);
  if (!before.prefix || after.prefix || bare(replacement) !== after.stem) return replacement;
  const joiner = /^\d/u.test(replacement) ? "-" : "";
  return `${before.prefix}${joiner}${replacement}`;
}

/** "בחמש" is "חמש", and "ב-4" is "4", keeping any punctuation around the word. */
function withoutPrefix(token: string): string {
  const { prefix } = prefixAndStem(token);
  if (!prefix) return token;
  const at = token.indexOf(prefix);
  return token.slice(0, at) + token.slice(at + prefix.length).replace(/^-/u, "");
}

export function applySelfCorrections(text: string): string {
  const tokens = text.split(/\s+/u).filter(Boolean);
  const output: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const cueLength = cueAt(tokens, index);
    const previous = output.at(-1);
    if (!cueLength || !previous) {
      output.push(tokens[index]!);
      continue;
    }

    // The cue must follow the word it corrects, with nothing but a comma between them.
    if (/[.!?;:]$/u.test(previous)) {
      output.push(tokens[index]!);
      continue;
    }
    let next = index + cueLength;
    const lead = bare(tokens[next] ?? "");
    const leadRepeated = LEADS.has(lead) && bare(output.at(-2) ?? "") === lead;
    if (leadRepeated) next += 1;
    const replacement = tokens[next];
    const kind = replacement ? kindOf(replacement) : null;
    if (!replacement || !kind || kindOf(previous) !== kind) {
      output.push(tokens[index]!);
      continue;
    }

    output.pop();
    // The lead word stays once: "ביום שני, סליחה, ביום שלישי" is "ביום שלישי".
    // After a lead the replaced word had no prefix, so the repair's own goes: "ביום שני, סליחה, בשלישי" is "ביום שלישי".
    const afterLead = !leadRepeated && LEADS.has(bare(output.at(-1) ?? "")) && !prefixAndStem(previous).prefix;
    output.push(afterLead ? withoutPrefix(replacement) : withPrefix(previous, replacement));
    index = next;
  }

  return output.join(" ");
}

/** Whether the words after a pause correct the words before it, as "ביום שני ‖ סליחה ביום שלישי" does. */
export function correctsAcross(before: string, after: string): boolean {
  const tail = before.split(/\s+/u).filter(Boolean).slice(-2).join(" ");
  const next = after.split(/\s+/u).filter(Boolean).join(" ");
  if (!tail || !next || cueAt(next.split(" "), 0) === 0) return false;
  return applySelfCorrections(`${tail} ${next}`) !== `${applySelfCorrections(tail)} ${applySelfCorrections(next)}`;
}
