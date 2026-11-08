import { bare } from "./hebrew-tokens";

// Stand for a spoken line break until the sentence split, which breaks on any whitespace.
export const SPOKEN_LINE_BREAK = "";
export const SPOKEN_PARAGRAPH_BREAK = "";

const ATTACHED = "attached";
const JOINING = "joining";
const SPACED = "spaced";
const BREAK = "break";
type Placement = typeof ATTACHED | typeof JOINING | typeof SPACED | typeof BREAK;

const COMMANDS: ReadonlyArray<{ spoken: string[]; written: string; placement: Placement }> = [
  { spoken: ["סימן", "שאלה"], written: "?", placement: ATTACHED },
  // Whisper often hears "סימן" before "שאלה" as "סימת".
  { spoken: ["סימת", "שאלה"], written: "?", placement: ATTACHED },
  { spoken: ["סימן", "קריאה"], written: "!", placement: ATTACHED },
  { spoken: ["שורה", "חדשה"], written: SPOKEN_LINE_BREAK, placement: BREAK },
  { spoken: ["ירידת", "שורה"], written: SPOKEN_LINE_BREAK, placement: BREAK },
  { spoken: ["פסקה", "חדשה"], written: SPOKEN_PARAGRAPH_BREAK, placement: BREAK },
  { spoken: ["קו", "מפריד"], written: "–", placement: SPACED },
  { spoken: ["נקודתיים"], written: ":", placement: ATTACHED },
  { spoken: ["נקודה"], written: ".", placement: ATTACHED },
  { spoken: ["פסיק"], written: ",", placement: ATTACHED },
  { spoken: ["מקף"], written: "-", placement: JOINING }
];

// These words turn a command into an ordinary noun: "עוד נקודה", "תוסיף שורה חדשה".
const LITERAL_BEFORE = new Set([
  "זו", "זאת", "זה", "עוד", "ועוד", "אותה", "אותו", "כל", "של", "יש", "אין", "על", "עם", "בלי", "כמו", "רק", "איזו", "איזה", "את", "המילה",
  "תוסיף", "תוסיפי", "הוסף", "הוסיפי", "להוסיף", "כתוב", "כתבי", "תכתוב", "תכתבי", "לכתוב", "שים", "שימי", "תשים", "תשימי", "לשים"
]);
const LITERAL_AFTER = new Set([
  "חשובה", "טובה", "מעניינת", "אחת", "נוספת", "אחרת", "קטנה", "גדולה", "יפה", "זו", "זאת", "של", "מעבר", "מפגש", "ציון", "זכות", "פתיחה", "התחלה", "מבט"
]);

/** Before a break, a verb of being makes the command a noun: "הייתה ירידת שורה באמצע". */
const LITERAL_BEFORE_BREAK = new Set(["היה", "הייתה", "היתה", "יהיה", "תהיה"]);

/** A pronoun before a command of the other gender is no phrase: "ראיתי אותו נקודה", "על זה שורה חדשה". */
const PRONOUN_GENDER: Record<string, "m" | "f"> = { זה: "m", אותו: "m", זו: "f", זאת: "f", אותה: "f" };
const DEMONSTRATIVES = new Set(["זה", "זו", "זאת"]);
/** A demonstrative after these is an object, "את זה", "על זה", so a command can follow it. */
const OBJECT_MARKERS = new Set([
  "את", "ואת", "על", "עם", "אל", "של", "בלי", "כמו", "מול", "אחרי", "לפני", "בגלל", "עד", "מן", "לגבי", "בשביל", "אצל"
]);
const MASCULINE_MARKS = new Set(["?", "!", ",", "-", "–"]);

/** Whether the pronoun before a command still lets it be a command, as "אני אוהב את זה נקודה" does. */
function pronounAllows(tokens: string[], index: number, command: (typeof COMMANDS)[number]): boolean {
  const previous = bare(tokens[index - 1] ?? "");
  const gender = PRONOUN_GENDER[previous];
  if (!gender) return false;
  // "זו נקודה מצוינת", "זה פסיק מיותר": a demonstrative that opens the clause names the noun after it.
  if (DEMONSTRATIVES.has(previous) && !OBJECT_MARKERS.has(bare(tokens[index - 2] ?? ""))) return false;
  if (gender !== (MASCULINE_MARKS.has(command.written) ? "m" : "f")) return true;
  // "את זה פסיק" is a mark; "אותה נקודה" is "the same point" and "על זה סימן שאלה" is a noun.
  return command.written === ",";
}

function commandAt(tokens: string[], index: number) {
  for (const command of COMMANDS) {
    const { spoken } = command;
    if (!spoken.every((word, offset) => bare(tokens[index + offset] ?? "") === word)) continue;
    const previous = bare(tokens[index - 1] ?? "");
    const next = bare(tokens[index + spoken.length] ?? "");
    const literalBefore = (LITERAL_BEFORE.has(previous) && !pronounAllows(tokens, index, command)) ||
      (command.placement === BREAK && LITERAL_BEFORE_BREAK.has(previous));
    if (!previous || literalBefore || LITERAL_AFTER.has(next)) return null;
    return command;
  }
  return null;
}

/** Whether the words at index say a spoken command, read with the words before them. */
export function spokenCommandAt(tokens: readonly string[], index: number): boolean {
  return commandAt([...tokens], index) !== null;
}

/** Turns dictated punctuation into the mark itself. Line breaks stay as placeholders. */
export function applySpokenCommands(text: string): string {
  const tokens = text.split(/\s+/u).filter(Boolean);
  const output: string[] = [];
  let joinNext = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const command = commandAt(tokens, index);
    if (!command) {
      output.push(joinNext ? `${output.pop() ?? ""}${tokens[index]}` : tokens[index]!);
      joinNext = false;
      continue;
    }

    index += command.spoken.length - 1;
    const previous = output.pop() ?? "";
    // Whisper may have punctuated the same pause. The spoken mark wins. A line break is no mark,
    // so it keeps an end mark before it ("מה שלומך סימן שאלה שורה חדשה") and drops only a comma.
    const stem = previous.replace(command.placement === BREAK ? /[,;]+$/u : /[.,:;!?]+$/u, "");
    if (command.placement === SPACED) output.push(stem, command.written);
    else output.push(`${stem}${command.written}`);
    joinNext = command.placement === JOINING;
  }

  return output.join(" ");
}

export function resolveSpokenBreaks(text: string): string {
  return text.replaceAll(new RegExp(`\\s*${SPOKEN_PARAGRAPH_BREAK}\\s*`, "gu"), "\n\n")
    .replaceAll(new RegExp(`\\s*${SPOKEN_LINE_BREAK}\\s*`, "gu"), "\n")
    .trim();
}
