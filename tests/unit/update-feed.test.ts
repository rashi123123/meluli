/* @vitest-environment node */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, findVerifiedUpdate, parseUpdateFeed, RejectedFeedError, releaseZipUrl } from "@main/services/update-feed";

const FEED_URL = "https://github.com/rashi123123/meluli/releases/latest/download/releases.json";

function feed(version = "1.2.3", overrides: Record<string, unknown> = {}) {
  const updateTo = { version, name: version, pub_date: "2026-11-02T00:00:00.000Z", notes: "", url: releaseZipUrl(version), ...overrides };
  return JSON.stringify({ currentRelease: version, releases: [{ version, updateTo }] });
}

const respond = (status: number, body: string | null = null, location?: string) =>
  new Response(body, { status, headers: location ? { location } : {} });

afterEach(() => { vi.unstubAllGlobals(); });

describe("compareVersions", () => {
  it.each([
    ["1.0.1", "1.0.0"],
    ["1.10.0", "1.9.0"],
    ["0.1.0", "0.1.0-preview.2"],
    ["0.1.0-preview.10", "0.1.0-preview.2"],
    ["0.1.0-preview.2.1", "0.1.0-preview.2"],
    ["0.1.0-rc.1", "0.1.0-preview.9"]
  ])("orders %s after %s", (later, earlier) => {
    expect(compareVersions(later, earlier)).toBeGreaterThan(0);
    expect(compareVersions(earlier, later)).toBeLessThan(0);
  });

  it("treats a version as equal to itself and refuses anything else", () => {
    expect(compareVersions("0.1.0-preview.2", "0.1.0-preview.2")).toBe(0);
    expect(() => compareVersions("latest", "1.0.0")).toThrow(RejectedFeedError);
  });
});

describe("parseUpdateFeed", () => {
  it("offers only a newer version", () => {
    expect(parseUpdateFeed(feed("1.2.3"), "1.2.2")).toBe("1.2.3");
    expect(parseUpdateFeed(feed("1.2.3"), "1.2.3")).toBeNull();
    expect(parseUpdateFeed(feed("1.2.3"), "1.3.0")).toBeNull();
  });

  it.each([
    ["not JSON", "<html>"],
    ["the wrong shape", JSON.stringify({ currentRelease: "1.2.3" })],
    ["an unlisted current release", JSON.stringify({ currentRelease: "1.2.3", releases: [] })],
    ["a plain HTTP archive", feed("1.2.3", { url: "http://github.com/rashi123123/meluli/releases/download/v1.2.3/Meluli-1.2.3-arm64.zip" })],
    ["an archive on another host", feed("1.2.3", { url: "https://example.test/Meluli-1.2.3-arm64.zip" })],
    ["another repository's archive", feed("1.2.3", { url: "https://github.com/someone/meluli/releases/download/v1.2.3/Meluli-1.2.3-arm64.zip" })],
    ["an older version's archive", feed("1.2.3", { url: releaseZipUrl("1.2.2") })],
    ["a name Squirrel would report differently", feed("1.2.3", { name: "9.9.9" })]
  ])("rejects %s", (_name, text) => {
    expect(() => parseUpdateFeed(text, "1.0.0")).toThrow(RejectedFeedError);
  });
});

describe("findVerifiedUpdate", () => {
  it("follows GitHub's redirects to its asset host, one verified hop at a time", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(302, null, "https://github.com/rashi123123/meluli/releases/download/v1.2.3/releases.json"))
      .mockResolvedValueOnce(respond(302, null, "https://release-assets.githubusercontent.com/asset?sig=abc"))
      .mockResolvedValueOnce(respond(200, feed()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(findVerifiedUpdate(FEED_URL, "1.0.0")).resolves.toBe("1.2.3");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual", credentials: "omit" });
  });

  it.each([
    ["a plain HTTP feed", "http://github.com/rashi123123/meluli/releases/latest/download/releases.json"],
    ["a look-alike host", "https://github.com.example.test/releases.json"],
    ["a feed URL with credentials", "https://user:secret@github.com/releases.json"],
    ["another port", "https://github.com:8443/releases.json"]
  ])("never requests %s", async (_name, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(findVerifiedUpdate(url, "1.0.0")).rejects.toThrow(RejectedFeedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops at a redirect off the allowed hosts or down to HTTP", async () => {
    for (const location of ["https://example.test/releases.json", "http://release-assets.githubusercontent.com/asset"]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(respond(302, null, location));
      vi.stubGlobal("fetch", fetchMock);
      await expect(findVerifiedUpdate(FEED_URL, "1.0.0")).rejects.toThrow(RejectedFeedError);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("bounds a redirect loop and an oversized feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(302, null, FEED_URL)));
    await expect(findVerifiedUpdate(FEED_URL, "1.0.0")).rejects.toThrow(RejectedFeedError);
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, " ".repeat(64 * 1024 + 1))));
    await expect(findVerifiedUpdate(FEED_URL, "1.0.0")).rejects.toThrow("too large");
  });

  it("takes a missing release as nothing to do, and a server error as a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(404)));
    await expect(findVerifiedUpdate(FEED_URL, "1.0.0")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => respond(503)));
    const failure = await findVerifiedUpdate(FEED_URL, "1.0.0").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RejectedFeedError);
  });
});

describe("write-update-feed", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const run = (url: string, output: string) => spawnSync(process.execPath, ["scripts/write-update-feed.mjs", url, output],
    { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });

  it("writes a feed the app accepts, and refuses any other archive address", () => {
    const folder = mkdtempSync(join(tmpdir(), "update-feed-"));
    try {
      const output = join(folder, "releases.json");
      expect(run("https://example.test/Meluli.zip", output).status).toBe(1);
      expect(run(releaseZipUrl(version), output).status).toBe(0);
      expect(parseUpdateFeed(readFileSync(output, "utf8"), "0.0.1")).toBe(version);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
