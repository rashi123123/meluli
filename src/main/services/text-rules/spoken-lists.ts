import { SPOKEN_LINE_BREAK, SPOKEN_PARAGRAPH_BREAK } from "./spoken-commands";
import { bare } from "./hebrew-tokens";

/**
 * "דבר ראשון… דבר שני…" and "ראשית… שנית…" become a numbered list. It takes the first marker
 * and at least a second one in order, so a lone "ראשית" or "דבר שני" stays prose.
 */

/** Stands for the dot after a list number until the sentence split has run, which breaks on "1.". */
const LIST_NUMBER_DOT = "";

const ORDINALS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שביעי", "שמיני", "תשיעי", "עשירי"];
const ADVERBS = ["ראשית", "שנית", "שלישית", "רביעית", "חמישית", "שישית", "שביעית", "שמינית", "תשיעית", "עשירית"];
const LAST_ITEM = [["דבר", "אחרון"], ["ודבר", "אחרון"], ["ולבסוף"], ["לבסוף"]];

const withoutAnd = (word: string) => (word.length > 2 && word.startsWith("ו") ? word.slice(1) : word);

interface Marker { index: number; length: number; position: number }

/** The list position a marker at index stands for, or null. */
function markerAt(tokens: string[], index: number, style: "noun" | "adverb" | null): Marker | null {
  const first = withoutAnd(bare(tokens[index] ?? ""));
  if (style !== "adverb" && first === "דבר") {
    const position = ORDINALS.indexOf(bare(tokens[index + 1] ?? ""));
    if (position >= 0) return { index, length: 2, position: position + 1 };
  }
  if (style !== "noun") {
    const position = ADVERBS.indexOf(first);
    if (position >= 0) return { index, length: 1, position: position + 1 };
  }
  return null;
}

function lastItemAt(tokens: string[], index: number): number {
  for (const words of LAST_ITEM) {
    if (words.every((word, offset) => bare(tokens[index + offset] ?? "") === word)) return words.length;
  }
  return 0;
}

export function applySpokenLists(text: string): string {
  const tokens = text.split(/\s+/u).filter(Boolean);
  const start = tokens.findIndex((_, index) => markerAt(tokens, index, null)?.position === 1);
  if (start < 0) return text;
  const style = bare(withoutAnd(tokens[start]!)) === "דבר" ? "noun" : "adverb";

  const markers: Marker[] = [markerAt(tokens, start, style)!];
  for (let index = start + markers[0]!.length; index < tokens.length; index += 1) {
    const expected = markers.length + 1;
    const marker = markerAt(tokens, index, style);
    if (marker?.position === expected) {
      markers.push(marker);
      index += marker.length - 1;
      continue;
    }
    const lastLength = markers.length >= 2 ? lastItemAt(tokens, index) : 0;
    if (lastLength) {
      markers.push({ index, length: lastLength, position: expected });
      break;
    }
  }
  if (markers.length < 2) return text;

  // The last item runs to the end of its sentence; whatever follows is a new paragraph.
  const lastMarker = markers.at(-1)!;
  let end = tokens.length;
  for (let index = lastMarker.index + lastMarker.length; index < tokens.length - 1; index += 1) {
    if (/[.!?]$/u.test(tokens[index]!)) {
      end = index + 1;
      break;
    }
  }

  // A marker said with nothing after it is no item: a trailing one goes back to the text after the list,
  // and one inside the list is dropped, so "דבר שלישי, דבר רביעי ביצים" makes no empty item.
  const wordsOf = (marker: Marker, position: number) =>
    tokens.slice(marker.index + marker.length, markers[position + 1]?.index ?? end).filter((token) => bare(token));
  while (markers.length > 2 && wordsOf(markers.at(-1)!, markers.length - 1).length === 0) end = markers.pop()!.index;
  const items = markers
    .map((marker, position) => ({ marker, words: tokens.slice(marker.index + marker.length, markers[position + 1]?.index ?? end) }))
    .filter((_, position) => wordsOf(markers[position]!, position).length > 0);
  // The first item must have words, or "דבר ראשון, דבר שני, הכי חשוב" was no list.
  if (items.length < 2 || items[0]!.marker !== markers[0]) return text;

  const intro = tokens.slice(0, start);
  if (intro.length > 0) intro[intro.length - 1] = `${intro.at(-1)!.replace(/[.,;:]+$/u, "")}:`;
  const lines = items.map(({ words }, position) => {
    // The comma after "דבר ראשון," goes with the marker token.
    if (words.length > 0) words[0] = words[0]!.replace(/^[,:\-–]+/u, "");
    // A comma that only separated it from the next item goes; a sentence end stays.
    if (words.length > 0) words[words.length - 1] = words.at(-1)!.replace(/[,;]+$/u, "");
    return `${position + 1}${LIST_NUMBER_DOT} ${words.filter(Boolean).join(" ")}`;
  });
  const rest = tokens.slice(end);
  return [
    intro.join(" "),
    ...lines.map((line) => `${SPOKEN_LINE_BREAK} ${line}`),
    rest.length > 0 ? `${SPOKEN_PARAGRAPH_BREAK} ${rest.join(" ")}` : ""
  ].filter(Boolean).join(" ");
}

export function resolveListNumbers(text: string): string {
  return text.replaceAll(LIST_NUMBER_DOT, ".");
}
