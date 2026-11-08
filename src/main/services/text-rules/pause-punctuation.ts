import type { TranscriptSegment } from "@shared/types";
import { isDigitWord } from "./hebrew-numbers";
import { bare } from "./hebrew-tokens";
import { correctsAcross } from "./self-corrections";
import { SPOKEN_PARAGRAPH_BREAK, spokenCommandAt } from "./spoken-commands";

/**
 * Silence between the model's segments marks where a sentence or a paragraph ends.
 * Segment times are approximate and a segment may stop mid-sentence, so only a clear pause counts.
 */
const SENTENCE_PAUSE_SECONDS = 1;
const PARAGRAPH_PAUSE_SECONDS = 2;
const MIN_SENTENCE_WORDS = 3;
const MIN_PARAGRAPH_WORDS = 12;
/** A segment that opens with one of these continues the sentence before it, whatever the pause. */
const CONTINUES = new Set(["ש", "כאשר", "כי", "אשר", "אלא", "או", "אבל", "וגם", "כמו"]);

export interface PauseOptions {
  /** Dictation: a spoken mark or correction said after a pause belongs to the words before it. */
  spokenCommands?: boolean;
}

const collapse = (text: string) => text.replace(/\s+/gu, "");
const wordCount = (text: string) => text.split(/\s+/u).filter(Boolean).length;

/** The text rebuilt from its segments with pause marks, or null when the segments do not spell the same text. */
export function textWithPauses(
  text: string,
  segments: readonly TranscriptSegment[] | null | undefined,
  { spokenCommands = false }: PauseOptions = {}
): string | null {
  if (!segments || segments.length < 2) return null;
  if (collapse(segments.map((segment) => segment.text).join("")) !== collapse(text)) return null;

  let result = "";
  let wordsInParagraph = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    let piece = segment.text.trim();
    if (!piece) continue;
    wordsInParagraph += wordCount(piece);
    const next = segments[index + 1];
    if (next) {
      const pause = next.start - segment.end;
      const words = piece.split(/\s+/u);
      const nextWords = next.text.trim().split(/\s+/u).filter(Boolean);
      const nextWord = nextWords[0] ?? "";
      // People pause before a spoken mark or a correction: "רעיון טוב ‖ נקודה", "ביום שני ‖ סליחה ביום שלישי".
      // "נקודה חשובה" or "סליחה על האיחור" after a pause is new speech.
      const spoken = spokenCommands &&
        (spokenCommandAt([...words, ...nextWords], words.length) || correctsAcross(piece, next.text));
      // A number said digit by digit, as a phone number, runs on across a pause; "עשרים ‖ שלושה לקוחות" does not.
      const digitsRunOn = words.length >= 2 && words.slice(-2).every((word) => isDigitWord(bare(word))) && isDigitWord(bare(nextWord));
      const continues = CONTINUES.has(nextWord) || spoken || digitsRunOn || /[,:;־-]$/u.test(piece);
      const ended = /[.!?…]$/u.test(piece);
      if (!ended && !continues && wordCount(piece) >= MIN_SENTENCE_WORDS && pause >= SENTENCE_PAUSE_SECONDS) piece += ".";
      if (!spoken && /[.!?…]$/u.test(piece) && pause >= PARAGRAPH_PAUSE_SECONDS && wordsInParagraph >= MIN_PARAGRAPH_WORDS) {
        piece += ` ${SPOKEN_PARAGRAPH_BREAK}`;
        wordsInParagraph = 0;
      }
    }
    result += (result ? " " : "") + piece;
  }
  return result;
}
