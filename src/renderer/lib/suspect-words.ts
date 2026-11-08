export interface TextPart {
  text: string;
  /** Set when this part is a word the transcriber may have got wrong. */
  suspect?: boolean;
}

/** Splits text around words flagged as uncertain, matched the way main flagged them: punctuation at the edges aside. */
export function splitSuspects(text: string, suspects: ReadonlySet<string>): TextPart[] {
  if (suspects.size === 0) return [{ text }];
  const parts: TextPart[] = [];
  let copied = 0;
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0];
    const lead = /^[^\p{L}\p{N}]*/u.exec(token)![0].length;
    const trail = /[^\p{L}\p{N}]*$/u.exec(token.slice(lead))![0].length;
    const core = token.slice(lead, token.length - trail);
    if (!core || !suspects.has(core)) continue;
    const start = match.index + lead;
    if (start > copied) parts.push({ text: text.slice(copied, start) });
    parts.push({ text: core, suspect: true });
    copied = start + core.length;
  }
  if (copied < text.length) parts.push({ text: text.slice(copied) });
  return parts;
}
