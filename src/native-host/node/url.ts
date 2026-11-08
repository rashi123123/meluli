// node:url: file URL conversion and the legacy `format` the window code uses.
import { SPECIAL_SCHEMES } from "../web/url";
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export function fileURLToPath(input: string | URL): string {
  const url = typeof input === "string" ? new globalThis.URL(input) : input;
  if (url.protocol !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
  if (url.hostname && url.hostname !== "localhost") throw Object.assign(new TypeError("File URL host must be \"localhost\" or empty on darwin"), { code: "ERR_INVALID_FILE_URL_HOST" });
  if (/%2f/i.test(url.pathname)) throw Object.assign(new TypeError("File URL path must not include encoded / characters"), { code: "ERR_INVALID_FILE_URL_PATH" });
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(path: string): URL {
  // A relative path resolves against the host's working directory, as Node's does against its own.
  const absolute = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
  const encoded = absolute.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  return new globalThis.URL(`file://${encoded}`);
}

export function format(input: URL | string | { protocol?: string; slashes?: boolean; auth?: string; host?: string; hostname?: string; port?: string | number; pathname?: string; search?: string; hash?: string }): string {
  if (typeof input === "string") return input;
  if (input instanceof globalThis.URL) return input.href;
  let protocol = input.protocol ?? "";
  if (protocol && !protocol.endsWith(":")) protocol += ":";
  const host = input.host ?? (input.hostname ? `${input.hostname}${input.port ? `:${input.port}` : ""}` : "");
  const special = SPECIAL_SCHEMES.has(protocol);
  const slashes = input.slashes || special || Boolean(host);
  const auth = input.auth ? `${encodeURIComponent(input.auth).replace(/%3A/i, ":")}@` : "";
  let pathname = (input.pathname ?? "").replace(/[?#]/g, encodeURIComponent);
  if (slashes && pathname && !pathname.startsWith("/")) pathname = `/${pathname}`;
  const search = input.search ? (input.search.startsWith("?") ? input.search : `?${input.search}`).replace(/#/g, "%23") : "";
  const hash = input.hash ? (input.hash.startsWith("#") ? input.hash : `#${input.hash}`) : "";
  return `${protocol}${slashes ? "//" : ""}${auth}${host}${pathname}${search}${hash}`;
}
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, format };
