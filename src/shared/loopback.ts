/**
 * This Mac's own addresses, as `URL.host` or `URL.hostname` give them (an IPv6 address keeps its
 * brackets). Used for the dev server the main window may load and for flow connections that may
 * use plain http.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for a loopback host, with or without a port. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ""));
}
