const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 6;

/** HTTPS on the default port, no credentials in the URL, and a host the caller accepts. */
export function isPinnedHttpsUrl(value: string, isAllowedHost: (hostname: string) => boolean): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      isAllowedHost(url.hostname);
  } catch { return false; }
}

export interface PinnedFetchOptions {
  isAllowed: (url: string) => boolean;
  signal: AbortSignal;
  headers?: Record<string, string>;
  messages: { untrusted: string; noDestination: string; tooMany: string };
  error?: (message: string) => Error;
}

/** Follows redirects by hand, so every hop is checked against the allowed hosts before it is fetched. */
export async function fetchPinned(url: string, options: PinnedFetchOptions): Promise<Response> {
  const fail = options.error ?? ((message: string) => new Error(message));
  for (let redirects = 0; redirects < MAX_REDIRECTS; redirects++) {
    if (!options.isAllowed(url)) throw fail(options.messages.untrusted);
    const response = await fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal: options.signal,
      ...(options.headers ? { headers: options.headers } : {})
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw fail(options.messages.noDestination);
    url = new URL(location, url).href;
  }
  throw fail(options.messages.tooMany);
}
