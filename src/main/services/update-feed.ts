import { z } from "zod";
import { REPOSITORY_URL } from "@shared/constants";

const MAX_FEED_BYTES = 64 * 1024;
const FEED_TIMEOUT_MS = 30_000;
// github.com answers a release asset with a redirect to its storage host.
const FEED_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

/** The feed answered, and what it said must not be acted on. */
export class RejectedFeedError extends Error {}

const feedSchema = z.object({
  currentRelease: z.string().regex(VERSION),
  releases: z.array(z.object({
    version: z.string(),
    updateTo: z.object({ version: z.string(), name: z.string(), url: z.string() })
  })).max(100)
});

function isFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && FEED_HOSTS.has(url.hostname);
  } catch { return false; }
}

function compareIdentifier(left: string, right: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(left) && numeric.test(right)) return Number(left) - Number(right);
  if (numeric.test(left) !== numeric.test(right)) return numeric.test(left) ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic version order: 0.1.0-preview.2 comes before 0.1.0. */
export function compareVersions(left: string, right: string): number {
  const [a, b] = [VERSION.exec(left), VERSION.exec(right)];
  if (!a || !b) throw new RejectedFeedError(`Not a version: ${left}, ${right}`);
  for (const part of [1, 2, 3]) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference) return difference;
  }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0;
  const [leftParts, rightParts] = [a[4].split("."), b[4].split(".")];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    const difference = compareIdentifier(leftParts[index]!, rightParts[index]!);
    if (difference) return difference;
  }
  return leftParts.length - rightParts.length;
}

/** An archive can only come from this repository's release of that very version. */
export function releaseZipUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/download/v${version}/Meluli-${version}-arm64.zip`;
}

/**
 * Squirrel moves to any version it does not recognise, so this is what refuses a downgrade.
 * The archive itself is Squirrel's to verify: it must match the running app's designated requirement.
 */
export function parseUpdateFeed(text: string, currentVersion: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new RejectedFeedError("The update feed is not JSON."); }
  const feed = feedSchema.safeParse(parsed);
  if (!feed.success) throw new RejectedFeedError("The update feed has the wrong shape.");
  const { currentRelease, releases } = feed.data;
  const release = releases.find(entry => entry.version === currentRelease);
  if (!release) throw new RejectedFeedError("The update feed does not list its current release.");
  if (release.updateTo.version !== currentRelease || release.updateTo.name !== currentRelease || release.updateTo.url !== releaseZipUrl(currentRelease)) {
    throw new RejectedFeedError("The update feed names an archive outside its release.");
  }
  return compareVersions(currentRelease, currentVersion) > 0 ? currentRelease : null;
}

async function readBounded(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body ?? []) {
    received += chunk.byteLength;
    if (received > MAX_FEED_BYTES) throw new RejectedFeedError("The update feed is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Returns the newer version the feed offers, or null. A release host without a release yet is not an error. */
export async function findVerifiedUpdate(feedUrl: string, currentVersion: string): Promise<string | null> {
  const signal = AbortSignal.timeout(FEED_TIMEOUT_MS);
  let url = feedUrl;
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!isFeedUrl(url)) throw new RejectedFeedError("Untrusted update feed host.");
    const response = await fetch(url, { redirect: "manual", credentials: "omit", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`The update feed returned HTTP ${response.status}.`);
      return parseUpdateFeed(await readBounded(response), currentVersion);
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new RejectedFeedError("The update feed redirect has no destination.");
    url = new URL(location, url).href;
  }
  throw new RejectedFeedError("Too many update feed redirects.");
}
