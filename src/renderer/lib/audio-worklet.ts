/// <reference lib="webworker" />
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: new (options?: unknown) => AudioWorkletProcessor): void;

class IvritRecorderProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(2048);
  private offset = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data?.type !== "stop") return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: "flushed" });
    };
  }

  private flush(): void {
    if (!this.offset) return;
    const chunk = this.offset === this.buffer.length ? this.buffer : this.buffer.slice(0, this.offset);
    this.port.postMessage(chunk, [chunk.buffer]);
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let index = 0; index < input.length;) {
      const count = Math.min(input.length - index, this.buffer.length - this.offset);
      this.buffer.set(input.subarray(index, index + count), this.offset);
      index += count; this.offset += count;
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor("ivrit-recorder-processor", IvritRecorderProcessor);
