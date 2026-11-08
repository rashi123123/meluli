// crypto: hashes through CryptoKit, UUIDs and random bytes through the system generator.
import { Buffer } from "./buffer";

class Hash {
  private id: number;
  private finished = false;
  constructor(readonly algorithm: string) { this.id = __native.hashCreate(algorithm.toLowerCase().replace("-", "")); }
  update(data: string | ArrayBufferView, encoding?: string): this {
    if (this.finished) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
    const bytes = typeof data === "string" ? (encoding && !/^utf-?8$/i.test(encoding) ? Buffer.from(data, encoding) : data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    __native.hashUpdate(this.id, bytes);
    return this;
  }
  digest(): Buffer;
  digest(encoding: string): string;
  digest(encoding?: string): Buffer | string {
    if (this.finished) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
    this.finished = true;
    const bytes = __native.hashDigest(this.id);
    const buffer = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    return encoding ? buffer.toString(encoding) : buffer;
  }
}

export function createHash(algorithm: string) { return new Hash(algorithm); }
export function randomUUID(): string { return __native.randomUUID(); }
export function randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void): Buffer {
  const bytes = __native.randomBytes(size);
  const buffer = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  if (callback) queueMicrotask(() => callback(null, buffer));
  return buffer;
}
export function randomInt(min: number, max?: number): number {
  if (max === undefined) { max = min; min = 0; }
  const range = max - min;
  const bytes = __native.randomBytes(6);
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return min + (value % range);
}
export function getRandomValues<T extends ArrayBufferView>(array: T): T { return globalThis.crypto.getRandomValues(array); }
export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let difference = 0;
  for (let index = 0; index < x.length; index++) difference |= x[index] ^ y[index];
  return difference === 0;
}
export const webcrypto = globalThis.crypto;
export default { createHash, randomUUID, randomBytes, randomInt, getRandomValues, timingSafeEqual, webcrypto };
