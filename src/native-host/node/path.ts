// POSIX path, the only flavour a macOS app needs.
export const sep = "/";
export const delimiter = ":";

function normalizeParts(parts: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!absolute) out.push(".."); continue; }
    out.push(part);
  }
  return out;
}

export function normalize(path: string): string {
  if (path === "") return ".";
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  let result = normalizeParts(path.split("/"), absolute).join("/");
  if (!result && !absolute) result = ".";
  if (result && trailing) result += "/";
  return (absolute ? "/" : "") + result;
}
export function isAbsolute(path: string) { return path.startsWith("/"); }
export function join(...paths: string[]): string {
  for (const path of paths) if (typeof path !== "string") throw new TypeError(`The "path" argument must be of type string. Received ${typeof path}`);
  const joined = paths.filter(Boolean).join("/");
  return joined ? normalize(joined) : ".";
}
export function resolve(...paths: string[]): string {
  let resolved = "";
  for (let index = paths.length - 1; index >= -1 && !resolved.startsWith("/"); index--) {
    const path = index >= 0 ? paths[index] : process.cwd();
    if (typeof path !== "string") throw new TypeError(`The "path" argument must be of type string. Received ${typeof path}`);
    if (path) resolved = resolved ? `${path}/${resolved}` : path;
  }
  const result = "/" + normalizeParts(resolved.split("/"), true).join("/");
  return result;
}
export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean), b = resolve(to).split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/");
}
export function dirname(path: string): string {
  if (!path) return ".";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return trimmed.slice(0, index).replace(/\/+$/, "") || "/";
}
export function basename(path: string, suffix?: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  let base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (suffix && base.endsWith(suffix) && base !== suffix) base = base.slice(0, -suffix.length);
  return base;
}
export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}
export function parse(path: string) {
  const root = path.startsWith("/") ? "/" : "";
  const base = basename(path), ext = extname(path);
  let dir = dirname(path);
  if (dir === "." && !path.includes("/")) dir = "";
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}
export function format(parts: { root?: string; dir?: string; base?: string; name?: string; ext?: string }): string {
  const dir = parts.dir || parts.root || "";
  const base = parts.base || `${parts.name ?? ""}${parts.ext ?? ""}`;
  return dir ? (dir === parts.root ? `${dir}${base}` : `${dir}/${base}`) : base;
}
export function toNamespacedPath(path: string) { return path; }
const path = { sep, delimiter, normalize, isAbsolute, join, resolve, relative, dirname, basename, extname, parse, format, toNamespacedPath } as Record<string, unknown>;
path.posix = path;
export const posix = path;
export default path;
