import { DICTIONARY_MAX_LENGTH } from "./constants";
import type { DictionaryEntry } from "./types";

export interface DictionarySuggestion {
  heard: string;
  written: string;
}

const MAX_WORDS = 2;
const MAX_HUNKS_PER_LINE = 3;
const MAX_CELLS = 40_000;
const HEBREW_PREFIXES = new Set("ובכלמהש");

const comparable = (value: string) => value.trim().toLowerCase();
const words = (text: string) => (text.match(/\S+/gu) ?? [])
  .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
  .filter(Boolean);

/** Runs of words that differ, by longest common subsequence. Null when the lines are too far apart to compare cheaply. */
function changedRuns(before: string[], after: string[]): Array<{ removed: string[]; added: string[] }> | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const left = before.slice(start, endBefore);
  const right = after.slice(start, endAfter);
  if (left.length === 0 && right.length === 0) return [];
  if ((left.length + 1) * (right.length + 1) > MAX_CELLS) return null;

  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const runs: Array<{ removed: string[]; added: string[] }> = [];
  let current: { removed: string[]; added: string[] } | null = null;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { current = null; i += 1; j += 1; continue; }
    current ??= runs[runs.push({ removed: [], added: [] }) - 1]!;
    if (j >= right.length || (i < left.length && table[i + 1]![j]! >= table[i]![j + 1]!)) current.removed.push(left[i++]!);
    else current.added.push(right[j++]!);
  }
  return runs;
}

/** "בריאקט" to "בReact" teaches "ריאקט" to "React": the dictionary already lets a term take a prefix. */
function dropSharedPrefix(heard: string, written: string): [string, string] {
  for (let length = 1; length <= 2; length += 1) {
    const prefix = heard.slice(0, length);
    if (![...prefix].every((letter) => HEBREW_PREFIXES.has(letter)) || !written.startsWith(prefix)) break;
    const rest = written.slice(length);
    if (/^[^֐-׿]/u.test(rest) && heard.length - length >= 3) return [heard.slice(length), rest];
  }
  return [heard, written];
}

/**
 * Word swaps a saved correction suggests teaching the dictionary.
 * A swap of one or two words is a misheard term; anything larger is a rewrite and is left alone.
 * `before` and `after` are the edited lines, in order.
 */
export function suggestDictionaryEntries(
  before: readonly string[],
  after: readonly string[],
  dictionary: readonly DictionaryEntry[],
  limit = 3
): DictionarySuggestion[] {
  const known = new Set(dictionary.map((entry) => comparable(entry.heard)));
  const writtenValues = new Set(dictionary.map((entry) => comparable(entry.written)));
  const suggestions: DictionarySuggestion[] = [];
  for (let line = 0; line < before.length && suggestions.length < limit; line += 1) {
    const next = after[line];
    if (next === undefined || next === before[line] || !next.trim()) continue;
    const runs = changedRuns(words(before[line]!), words(next));
    if (!runs || runs.length > MAX_HUNKS_PER_LINE) continue;
    for (const run of runs) {
      if (run.removed.length < 1 || run.removed.length > MAX_WORDS || run.added.length < 1 || run.added.length > MAX_WORDS) continue;
      const [heard, written] = dropSharedPrefix(run.removed.join(" "), run.added.join(" "));
      if (heard === written || heard.length > DICTIONARY_MAX_LENGTH || written.length > DICTIONARY_MAX_LENGTH) continue;
      if (known.has(comparable(heard)) || writtenValues.has(comparable(written))) continue;
      known.add(comparable(heard)); writtenValues.add(comparable(written));
      suggestions.push({ heard, written });
      if (suggestions.length >= limit) break;
    }
  }
  return suggestions;
}
