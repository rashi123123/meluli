import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Helpers frame messages on \n alone. Electron's readline also splits on U+2028 and U+2029,
 * which model text and app names can hold, and that would cut one JSON message in two.
 */
export class ProcessLines extends EventEmitter<{ line: [string]; close: [] }> {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private closed = false;

  constructor(private readonly input: Readable) {
    super();
    input.on("data", this.onData);
    input.once("end", this.onEnd);
    input.once("close", this.onEnd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onEnd);
    this.emit("close");
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let end = this.pending.indexOf("\n");
    while (end !== -1 && !this.closed) {
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      this.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
      end = this.pending.indexOf("\n");
    }
  };

  private readonly onEnd = (): void => {
    const rest = this.pending + this.decoder.end();
    this.pending = "";
    if (rest && !this.closed) this.emit("line", rest);
    this.close();
  };
}
