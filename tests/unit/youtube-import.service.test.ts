/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import { buildYtDlpDownloadArgs, buildYtDlpMetadataArgs, buildYtDlpProcessError, buildYtDlpRuntimeArgs, isLinkImportInstalled } from "@main/services/youtube-import.service";
import { he } from "@shared/locale";

describe("link import helper", () => {
  it("runs site scripts in the helper's own Deno and nothing else", () => {
    const args = buildYtDlpRuntimeArgs("/app/bin/youtube/deno");
    expect(args.slice(-3)).toEqual(["--no-js-runtimes", "--js-runtimes", "deno:/app/bin/youtube/deno"]);
    expect(args).toContain("--no-remote-components");
  });

  it("counts as installed only with both yt-dlp and Deno", () => {
    expect(isLinkImportInstalled({ ytDlpBinaryPath: process.execPath, denoBinaryPath: "/missing/deno" })).toBe(false);
    expect(isLinkImportInstalled({ ytDlpBinaryPath: "/missing/yt-dlp", denoBinaryPath: process.execPath })).toBe(false);
    expect(isLinkImportInstalled({ ytDlpBinaryPath: process.execPath, denoBinaryPath: process.execPath })).toBe(true);
  });
});

describe("buildYtDlpMetadataArgs", () => {
  it("requests metadata for a single YouTube video without downloading", () => {
    expect(buildYtDlpMetadataArgs("https://www.youtube.com/watch?v=demo123")).toEqual([
      "--dump-single-json",
      "--skip-download",
      "--ies",
      "default,-generic",
      "--no-playlist",
      "--playlist-items",
      "1",
      "--no-warnings",
      "https://www.youtube.com/watch?v=demo123"
    ]);
  });
});

describe("buildYtDlpDownloadArgs", () => {
  it("prefers audio-only m4a/mp4 compatible downloads and prints the final path", () => {
    expect(
      buildYtDlpDownloadArgs("https://youtu.be/demo123", "/tmp/ivrit-youtube/audio.%(ext)s")
    ).toEqual([
      "--ies",
      "default,-generic",
      "--no-playlist",
      "--playlist-items",
      "1",
      "--no-warnings",
      "--no-progress",
      "--print",
      "after_move:filepath",
      "-f",
      "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=mp4]/best[ext=m4a]/best[ext=mp3]/best[ext=mp4]",
      "-o",
      "/tmp/ivrit-youtube/audio.%(ext)s",
      "https://youtu.be/demo123"
    ]);
  });
});

describe("buildYtDlpProcessError", () => {
  it("names an unsupported site apart from a failed download", () => {
    expect(buildYtDlpProcessError({ signal: null, canceled: false, stderr: "ERROR: No suitable extractor found for URL https://example.com" }).message).toBe(he.linkUnsupportedSite);
    expect(buildYtDlpProcessError({ signal: null, canceled: false, stderr: "ERROR: Private video" }).message).toBe(he.youtubeDownloadFailed);
  });
});
