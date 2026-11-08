// URL and URLSearchParams. Parsing is Foundation's (RFC 3986 with percent-encoding of what it does
// not accept, `parseUrl` in Runtime.swift); the parts follow WHATWG's shapes ("https:", "?q", "#h").
/** WHATWG's special schemes (Runtime.swift `parseUrl` lists them too, without the colon). */
export const SPECIAL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443", "ftp:": "21" };

function encodeComponent(text: string) {
  return encodeURIComponent(text).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function decodeComponent(text: string) {
  try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; }
}

export class URLSearchParams {
  private list: [string, string][] = [];
  /** @internal */ _onChange?: () => void;
  constructor(init?: string | Record<string, string> | Iterable<[string, string]> | URLSearchParams) {
    if (typeof init === "string") this._parse(init);
    else if (init instanceof URLSearchParams) this.list = [...init.list];
    else if (init && typeof (init as Iterable<[string, string]>)[Symbol.iterator] === "function") for (const [k, v] of init as Iterable<[string, string]>) this.list.push([String(k), String(v)]);
    else if (init) for (const [k, v] of Object.entries(init)) this.list.push([k, String(v)]);
  }
  /** @internal */ _parse(text: string) {
    this.list = [];
    for (const part of text.replace(/^\?/, "").split("&")) {
      if (!part) continue;
      const index = part.indexOf("=");
      this.list.push(index < 0 ? [decodeComponent(part), ""] : [decodeComponent(part.slice(0, index)), decodeComponent(part.slice(index + 1))]);
    }
  }
  private changed() { this._onChange?.(); }
  get size() { return this.list.length; }
  append(name: string, value: string) { this.list.push([String(name), String(value)]); this.changed(); }
  delete(name: string) { this.list = this.list.filter(([key]) => key !== name); this.changed(); }
  get(name: string) { return this.list.find(([key]) => key === name)?.[1] ?? null; }
  getAll(name: string) { return this.list.filter(([key]) => key === name).map(([, value]) => value); }
  has(name: string) { return this.list.some(([key]) => key === name); }
  set(name: string, value: string) {
    const index = this.list.findIndex(([key]) => key === name);
    if (index < 0) this.list.push([String(name), String(value)]);
    else { this.list[index] = [String(name), String(value)]; this.list = this.list.filter(([key], i) => key !== name || i === index); }
    this.changed();
  }
  sort() { this.list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); this.changed(); }
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void) { for (const [key, value] of this.list) callback(value, key, this); }
  keys() { return this.list.map(([key]) => key)[Symbol.iterator](); }
  values() { return this.list.map(([, value]) => value)[Symbol.iterator](); }
  entries() { return this.list.map(([key, value]) => [key, value] as [string, string])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.list.map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`).join("&"); }
}

export class URL {
  protocol = ""; username = ""; password = ""; hostname = ""; port = ""; pathname = ""; hash = "";
  private _search = "";
  private _params: URLSearchParams | null = null;

  constructor(input: string | URL, base?: string | URL) {
    const parts = __native.parseUrl(String(input).trim(), base === undefined ? null : String(base));
    if (!parts) throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input: String(input) });
    this.protocol = parts.protocol;
    this.username = parts.username;
    this.password = parts.password;
    this.hostname = parts.hostname;
    this.port = DEFAULT_PORTS[parts.protocol] === parts.port ? "" : parts.port;
    this.pathname = parts.pathname || (SPECIAL_SCHEMES.has(parts.protocol) ? "/" : "");
    this._search = parts.search === "?" ? "" : parts.search;
    this.hash = parts.hash === "#" ? "" : parts.hash;
  }
  static canParse(input: string, base?: string) { try { new URL(input, base); return true; } catch { return false; } }

  get search() { return this._search; }
  set search(value: string) {
    const text = String(value);
    this._search = text === "" || text === "?" ? "" : text.startsWith("?") ? text : `?${text}`;
    this._params?._parse(this._search);
  }
  get searchParams() {
    if (!this._params) {
      const params = new URLSearchParams(this._search);
      params._onChange = () => { const text = params.toString(); this._search = text ? `?${text}` : ""; };
      this._params = params;
    }
    return this._params;
  }
  get host() { return this.port ? `${this.hostname}:${this.port}` : this.hostname; }
  /** Schemes with a default port are the ones with a tuple origin. */
  get origin() { return this.protocol in DEFAULT_PORTS ? `${this.protocol}//${this.host}` : "null"; }
  get href() {
    const auth = this.username ? `${this.username}${this.password ? `:${this.password}` : ""}@` : "";
    const authority = SPECIAL_SCHEMES.has(this.protocol) || this.hostname ? `//${auth}${this.host}` : "";
    return `${this.protocol}${authority}${this.pathname}${this._search}${this.hash}`;
  }
  set href(value: string) { Object.assign(this, new URL(value)); this._params = null; }
  toString() { return this.href; }
  toJSON() { return this.href; }
}
