// Node's Buffer as a Uint8Array subclass, covering the encodings and the little-endian accessors the
// app's WAV, protocol and hashing code use.
type Encoding = "utf8" | "utf-8" | "base64" | "base64url" | "hex" | "latin1" | "binary" | "ascii" | "utf16le" | "ucs2";

function normalize(encoding?: string): Encoding {
  const value = (encoding ?? "utf8").toLowerCase();
  if (["utf8", "utf-8", "base64", "base64url", "hex", "latin1", "binary", "ascii", "utf16le", "ucs2", "ucs-2", "utf-16le"].includes(value)) {
    return (value === "ucs-2" || value === "utf-16le" ? "utf16le" : value) as Encoding;
  }
  throw new TypeError(`Unknown encoding: ${encoding}`);
}

function encode(text: string, encoding?: string): Uint8Array {
  switch (normalize(encoding)) {
    case "utf8": case "utf-8": return __native.utf8Encode(text);
    case "base64": case "base64url": return __native.base64Decode(text);
    case "hex": {
      const bytes = new Uint8Array(Math.floor(text.length / 2));
      for (let index = 0; index < bytes.length; index++) {
        const byte = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
        if (Number.isNaN(byte)) return bytes.subarray(0, index);
        bytes[index] = byte;
      }
      return bytes;
    }
    case "utf16le": case "ucs2": {
      const bytes = new Uint8Array(text.length * 2);
      for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); bytes[index * 2] = code & 0xff; bytes[index * 2 + 1] = code >> 8; }
      return bytes;
    }
    default: {
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
      return bytes;
    }
  }
}

function decode(bytes: Uint8Array, encoding?: string): string {
  switch (normalize(encoding)) {
    case "utf8": case "utf-8": return __native.utf8Decode(bytes);
    case "base64": return __native.base64Encode(bytes);
    case "base64url": return __native.base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    case "hex": { let out = ""; for (const byte of bytes) out += byte.toString(16).padStart(2, "0"); return out; }
    case "utf16le": case "ucs2": { let out = ""; for (let index = 0; index + 1 < bytes.length; index += 2) out += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8)); return out; }
    case "ascii": { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte & 0x7f); return out; }
    default: { let out = ""; for (let index = 0; index < bytes.length; index += 0x8000) out += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return out; }
  }
}

let lastViewOwner: Uint8Array | null = null;
let lastView: DataView | null = null;

// @ts-expect-error Buffer.from takes Node's (value, encoding | offset, length), not Uint8Array.from's (items, mapfn).
export class Buffer extends Uint8Array {
  static readonly poolSize = 8192;

  static from(value: string | ArrayLike<number> | ArrayBufferLike | Uint8Array | { type: "Buffer"; data: number[] }, encodingOrOffset?: string | number, length?: number): Buffer {
    if (typeof value === "string") { const bytes = encode(value, encodingOrOffset as string | undefined); return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength); }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
      const offset = (encodingOrOffset as number | undefined) ?? 0;
      return new Buffer(value as ArrayBuffer, offset, length ?? (value as ArrayBuffer).byteLength - offset);
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      const copy = new Buffer(view.byteLength);
      copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      return copy;
    }
    if (value && typeof value === "object" && (value as { type?: string }).type === "Buffer") return Buffer.from((value as { data: number[] }).data);
    const list = value as ArrayLike<number>;
    const result = new Buffer(list.length);
    for (let index = 0; index < list.length; index++) result[index] = list[index] & 0xff;
    return result;
  }
  static alloc(size: number, fill?: number | string, encoding?: string): Buffer {
    const result = new Buffer(size);
    if (fill !== undefined) result.fill(fill as never, 0, size, encoding as never);
    return result;
  }
  static allocUnsafe(size: number): Buffer { return new Buffer(size); }
  static allocUnsafeSlow(size: number): Buffer { return new Buffer(size); }
  static isBuffer(value: unknown): value is Buffer { return value instanceof Buffer; }
  static isEncoding(encoding: string): boolean { try { normalize(encoding); return true; } catch { return false; } }
  static byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: string): number {
    if (typeof value === "string") return encode(value, encoding).byteLength;
    return value.byteLength;
  }
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.byteLength, 0);
    const result = new Buffer(total);
    let offset = 0;
    for (const item of list) { if (offset >= total) break; const part = item.subarray(0, total - offset); result.set(part, offset); offset += part.byteLength; }
    return result;
  }
  static compare(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  // Typed-array methods that build new arrays must build Buffers.
  static get [Symbol.species]() { return Buffer; }

  override toString(encoding?: string, start = 0, end = this.length): string { return decode(this.subarray(start, end), encoding); }
  toJSON() { return { type: "Buffer" as const, data: Array.from(this) }; }
  equals(other: Uint8Array): boolean { return Buffer.compare(this, other) === 0; }
  compare(other: Uint8Array): number { return Buffer.compare(this, other); }
  override subarray(start?: number, end?: number): Buffer { const view = super.subarray(start, end); return new Buffer(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength); }
  override slice(start?: number, end?: number): Buffer { return this.subarray(start, end); }
  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const part = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + target.length - targetStart));
    target.set(part, targetStart);
    return part.length;
  }
  write(text: string, offset = 0, length?: number, encoding?: string): number {
    const bytes = encode(text, encoding);
    const count = Math.min(bytes.length, length ?? this.length - offset, this.length - offset);
    this.set(bytes.subarray(0, count), offset);
    return count;
  }
  override fill(value: number | string | Uint8Array, start = 0, end = this.length, encoding?: string): this {
    if (typeof value === "number") return super.fill(value & 0xff, start, end);
    const pattern = typeof value === "string" ? encode(value, encoding) : value;
    if (pattern.length === 0) return super.fill(0, start, end);
    for (let index = start; index < end; index++) this[index] = pattern[(index - start) % pattern.length];
    return this;
  }
  /** One DataView per buffer at a time: encoders call the accessors once per sample. */
  private view() {
    if (lastViewOwner !== this) { lastView = new DataView(this.buffer, this.byteOffset, this.byteLength); lastViewOwner = this; }
    return lastView!;
  }
  readUInt8(offset = 0) { return this.view().getUint8(offset); }
  readInt8(offset = 0) { return this.view().getInt8(offset); }
  readUInt16LE(offset = 0) { return this.view().getUint16(offset, true); }
  readUInt16BE(offset = 0) { return this.view().getUint16(offset, false); }
  readInt16LE(offset = 0) { return this.view().getInt16(offset, true); }
  readUInt32LE(offset = 0) { return this.view().getUint32(offset, true); }
  readUInt32BE(offset = 0) { return this.view().getUint32(offset, false); }
  readInt32LE(offset = 0) { return this.view().getInt32(offset, true); }
  readFloatLE(offset = 0) { return this.view().getFloat32(offset, true); }
  readDoubleLE(offset = 0) { return this.view().getFloat64(offset, true); }
  writeUInt8(value: number, offset = 0) { this.view().setUint8(offset, value); return offset + 1; }
  writeInt8(value: number, offset = 0) { this.view().setInt8(offset, value); return offset + 1; }
  writeUInt16LE(value: number, offset = 0) { this.view().setUint16(offset, value, true); return offset + 2; }
  writeUInt16BE(value: number, offset = 0) { this.view().setUint16(offset, value, false); return offset + 2; }
  writeInt16LE(value: number, offset = 0) { this.view().setInt16(offset, value, true); return offset + 2; }
  writeUInt32LE(value: number, offset = 0) { this.view().setUint32(offset, value, true); return offset + 4; }
  writeUInt32BE(value: number, offset = 0) { this.view().setUint32(offset, value, false); return offset + 4; }
  writeInt32LE(value: number, offset = 0) { this.view().setInt32(offset, value, true); return offset + 4; }
  writeFloatLE(value: number, offset = 0) { this.view().setFloat32(offset, value, true); return offset + 4; }
  writeDoubleLE(value: number, offset = 0) { this.view().setFloat64(offset, value, true); return offset + 8; }
}

export const constants = { MAX_LENGTH: 2 ** 32 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 };
export default { Buffer, constants };
