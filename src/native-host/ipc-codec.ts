// IPC payloads cross WebKit as JSON strings, between the app's main code and each page, in both
// directions. What JSON loses and the app sends is tagged: binary data as base64 under its view's
// type name (a Buffer travels as a Uint8Array, as with Electron's structured clone), and dates.
// The host side (electron/bridge.ts) and the page side (renderer/electron.ts) both use this codec;
// only their base64 functions differ.

interface Base64 {
  encode(bytes: Uint8Array): string;
  decode(text: string): Uint8Array;
}

type ViewConstructor = { new (buffer: ArrayBuffer): ArrayBufferView; readonly BYTES_PER_ELEMENT: number };

const VIEWS: Record<string, ViewConstructor> = {
  Uint8Array, Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array
};

function wholeBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
}

export function createIpcCodec(base64: Base64): { encode(value: unknown): string; decode(text: unknown): unknown } {
  return {
    encode(value) {
      if (value === undefined) return "undefined";
      return JSON.stringify(value, function (this: Record<string, unknown>, key) {
        // `this[key]`, not the argument: Buffer and Date have toJSON, which runs first.
        const raw = this[key];
        if (raw instanceof ArrayBuffer) return { __meluliBinary: "ArrayBuffer", data: base64.encode(new Uint8Array(raw)) };
        if (ArrayBuffer.isView(raw)) {
          const name = VIEWS[raw.constructor.name] ? raw.constructor.name : "Uint8Array";
          return { __meluliBinary: name, data: base64.encode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) };
        }
        if (raw instanceof Date) return { __meluliDate: raw.getTime() };
        if (raw instanceof Map) return Object.fromEntries(raw);
        if (raw instanceof Set) return [...raw];
        if (typeof raw === "bigint") return Number(raw);
        return raw;
      });
    },
    decode(text) {
      if (typeof text !== "string" || text === "undefined") return undefined;
      return JSON.parse(text, (_key, value) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (typeof value.__meluliBinary === "string" && typeof value.data === "string") {
            const bytes = base64.decode(value.data);
            if (value.__meluliBinary === "ArrayBuffer") return wholeBuffer(bytes);
            const View = VIEWS[value.__meluliBinary] ?? Uint8Array;
            if (View === Uint8Array) return bytes;
            if (bytes.byteLength % View.BYTES_PER_ELEMENT !== 0) throw new RangeError("Binary payload is not a whole number of elements");
            return new View(wholeBuffer(bytes));
          }
          if (typeof value.__meluliDate === "number" && Object.keys(value).length === 1) return new Date(value.__meluliDate);
        }
        return value;
      });
    }
  };
}
