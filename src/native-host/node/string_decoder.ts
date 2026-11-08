// StringDecoder for UTF-8 child-process output: a character split across chunks is held back.

export class StringDecoder {
  private readonly decoder: TextDecoder;
  constructor(readonly encoding = "utf8") {
    const name = encoding.toLowerCase();
    if (name !== "utf8" && name !== "utf-8") throw new TypeError(`Unsupported StringDecoder encoding: ${encoding}`);
    this.decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  }
  write(chunk: Uint8Array | string): string {
    if (typeof chunk === "string") return chunk;
    return this.decoder.decode(chunk, { stream: true });
  }
  end(chunk?: Uint8Array): string {
    const text = chunk ? this.write(chunk) : "";
    return text + this.decoder.decode(new Uint8Array(0));
  }
}
export default { StringDecoder };
