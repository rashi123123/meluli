// The recorder's PCM, shared by the capture controller and the spool that writes it to disk.

/** The rate the recorder captures at; the worker takes 16 kHz mono as it is. */
export const CAPTURE_SAMPLE_RATE = 16_000;

export function mergeFloatChunks(chunks: Float32Array[], totalLength: number): Float32Array {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
