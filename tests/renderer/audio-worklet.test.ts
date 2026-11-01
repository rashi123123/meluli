import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

afterEach(() => vi.unstubAllGlobals());
it("batches render quanta and flushes each sample exactly once on stop", () => {
  const postMessage = vi.fn();
  class ProcessorBase { port = { postMessage, onmessage: null as ((event: { data: unknown }) => void) | null }; }
  type Processor = ProcessorBase & { process(inputs: Float32Array[][]): boolean };
  let create!: new () => Processor;
  const source = readFileSync(`${process.cwd()}/src/renderer/lib/audio-worklet.ts`, "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, {
    AudioWorkletProcessor: ProcessorBase, Float32Array,
    registerProcessor: (_name: string, constructor: new () => Processor) => { create = constructor; }
  });
  const processor = new create();
  for (let i = 0; i < 17; i++) processor.process([[new Float32Array(128).fill(i)]]);
  expect(postMessage).toHaveBeenCalledTimes(1);
  const [first, transferred] = postMessage.mock.calls[0];
  expect(first).toHaveLength(2048);
  expect(transferred).toEqual([first.buffer]);
  expect(first[2047]).toBe(15);
  processor.port.onmessage!({ data: { type: "stop" } });
  expect(postMessage.mock.calls[1][0]).toEqual(new Float32Array(128).fill(16));
  expect(postMessage.mock.calls[2][0]).toEqual({ type: "flushed" });
  expect(processor.process([[new Float32Array(128)]])).toBe(false);
  expect(postMessage).toHaveBeenCalledTimes(3);
});
