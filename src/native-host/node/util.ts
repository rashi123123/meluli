// util: promisify (with the custom hook execFile uses), inspect for log lines, and type checks.
const custom = Symbol.for("nodejs.util.promisify.custom");

export function promisify<T extends (...args: any[]) => any>(original: T): (...args: any[]) => Promise<any> {
  const hooked = (original as unknown as Record<symbol, unknown>)[custom];
  if (typeof hooked === "function") return hooked as (...args: any[]) => Promise<any>;
  return (...args: any[]) => new Promise((resolve, reject) => {
    original(...args, (error: unknown, value: unknown) => (error ? reject(error) : resolve(value)));
  });
}
promisify.custom = custom;

export function inspect(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try { return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item)) ?? String(value); } catch { return String(value); }
}
inspect.custom = Symbol.for("nodejs.util.inspect.custom");

export function format(pattern: unknown, ...args: unknown[]): string {
  if (typeof pattern !== "string") return [pattern, ...args].map((item) => (typeof item === "string" ? item : inspect(item))).join(" ");
  let index = 0;
  const text = pattern.replace(/%[sdifjoO%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= args.length) return token;
    const item = args[index++];
    switch (token) {
      case "%s": return typeof item === "string" ? item : String(item);
      case "%d": case "%i": return String(Math.trunc(Number(item)));
      case "%f": return String(Number(item));
      default: return inspect(item);
    }
  });
  return [text, ...args.slice(index).map((item) => (typeof item === "string" ? item : inspect(item)))].join(" ");
}

export function deprecate<T extends (...args: any[]) => any>(fn: T): T { return fn; }
export function inherits(child: { prototype: object }, parent: { prototype: object }) { Object.setPrototypeOf(child.prototype, parent.prototype); Object.setPrototypeOf(child, parent); }
export function isDeepStrictEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export const types = {
  isPromise: (value: unknown) => value instanceof Promise,
  isDate: (value: unknown) => value instanceof Date,
  isRegExp: (value: unknown) => value instanceof RegExp,
  isUint8Array: (value: unknown) => value instanceof Uint8Array,
  isArrayBuffer: (value: unknown) => value instanceof ArrayBuffer,
  isAnyArrayBuffer: (value: unknown) => value instanceof ArrayBuffer,
  isTypedArray: (value: unknown) => ArrayBuffer.isView(value) && !(value instanceof DataView),
  isNativeError: (value: unknown) => value instanceof Error
};
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export default { promisify, inspect, format, deprecate, inherits, isDeepStrictEqual, types, TextEncoder, TextDecoder };
