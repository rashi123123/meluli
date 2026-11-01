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
  { spoken: ["סימן", "קריאה"], written: "!", placement: ATTACHED },
  { spoken: ["שורה", "חדשה"], written: SPOKEN_LINE_BREAK, placement: BREAK },
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

const bare = (token: string): string => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

function commandAt(tokens: string[], index: number) {
  for (const command of COMMANDS) {
    const { spoken } = command;
    if (!spoken.every((word, offset) => bare(tokens[index + offset] ?? "") === word)) continue;
    const previous = bare(tokens[index - 1] ?? "");
    const next = bare(tokens[index + spoken.length] ?? "");
    if (!previous || LITERAL_BEFORE.has(previous) || LITERAL_AFTER.has(next)) return null;
    return command;
  }
  return null;
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
    // Whisper may have punctuated the same pause. The spoken mark wins.
    const stem = previous.replace(/[.,:;!?]+$/u, "");
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
