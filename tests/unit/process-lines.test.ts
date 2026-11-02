/* @vitest-environment node */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ProcessLines } from "../../src/main/services/process-lines";

function collect(input: PassThrough) {
  const seen: string[] = [];
  const lines = new ProcessLines(input);
  lines.on("line", line => seen.push(line));
  return { seen, lines };
}

describe("ProcessLines", () => {
  it("keeps line separators inside one message", () => {
    const input = new PassThrough();
    const { seen } = collect(input);
    input.write(`${JSON.stringify({ text: "a b c" })}\n`);
    expect(seen).toEqual(['{"text":"a b c"}']);
  });

  it("rejoins a character split across chunks and a line split across writes", () => {
    const input = new PassThrough();
    const { seen } = collect(input);
    const bytes = Buffer.from("שלום\nעוד", "utf8");
    input.write(bytes.subarray(0, 3));
    input.write(bytes.subarray(3));
    input.end(" שורה\r\n");
    expect(seen).toEqual(["שלום", "עוד שורה"]);
  });

  it("delivers an unterminated last line and stops after close", async () => {
    const input = new PassThrough();
    const { seen, lines } = collect(input);
    const closed = new Promise<void>(resolve => { lines.once("close", resolve); });
    input.end("last");
    await closed;
    expect(seen).toEqual(["last"]);

    const other = new PassThrough();
    const second = collect(other);
    second.lines.close();
    other.write("ignored\n");
    expect(second.seen).toEqual([]);
  });
});
