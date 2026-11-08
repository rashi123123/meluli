/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { he } from "@shared/locale";
import { YouTubeImportService } from "@main/services/youtube/youtube-import.service";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const PROCESS_DEADLINE_MS = 6 * 60 * 60_000;
const url = "https://www.youtube.com/watch?v=demo123";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill: vi.fn((signal: string) => { queueMicrotask(() => child.emit("close", null, signal)); return true; })
  });
  return child;
}

/** Answers the metadata step, then lets the test decide what the download step prints. */
function answer(download: (tempDir: string) => Promise<string>, metadata = '{"title":"t"}') {
  vi.mocked(spawn).mockImplementation(((_file: string, args: string[]) => {
    const child = fakeChild();
    queueMicrotask(() => void (async () => {
      const template = args[args.indexOf("-o") + 1];
      child.stdout.write(args.includes("--dump-single-json") ? metadata : `${await download(dirname(template))}\n`);
      child.stdout.end();
      await new Promise((resolve) => setImmediate(resolve));
      child.emit("close", 0, null);
    })());
    return child;
  }) as never);
}

const service = () => new YouTubeImportService({ ytDlpBinaryPath: process.execPath, denoBinaryPath: process.execPath });

describe("link import limits", () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("gives a stuck helper the deadline, then fails without calling it a cancel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child as never);
    const download = service().downloadAudio(url);
    const outcome = expect(download).rejects.toThrow(he.youtubeDownloadFailed);
    await vi.advanceTimersByTimeAsync(PROCESS_DEADLINE_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await outcome;
  });
});

describe("the source link the helper reports", () => {
  afterEach(() => { vi.clearAllMocks(); });
  const inFolder = async (tempDir: string) => { const file = join(tempDir, "audio.m4a"); await writeFile(file, "a"); return file; };

  it("is kept when it is a link the app would accept", async () => {
    answer(inFolder, '{"webpage_url":"https://www.youtube.com/watch?v=canonical"}');
    const result = await service().downloadAudio(url);
    expect(result.sourceUrl).toBe("https://www.youtube.com/watch?v=canonical");
    await result.cleanup();
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "http://www.youtube.com/watch?v=x", "https://localhost/x"])(
    "falls back to the submitted link for %s", async (reported) => {
      answer(inFolder, JSON.stringify({ webpage_url: reported }));
      const result = await service().downloadAudio(url);
      expect(result.sourceUrl).toBe(url);
      await result.cleanup();
    });
});

describe("the path the helper reports", () => {
  let outside: string;
  beforeEach(async () => { outside = await mkdtemp(join(tmpdir(), "link-import-outside-")); });
  afterEach(async () => { await rm(outside, { recursive: true, force: true }); vi.clearAllMocks(); });

  it("is used when it is a file in the import's own folder", async () => {
    answer(async (tempDir) => { const file = join(tempDir, "audio.m4a"); await writeFile(file, "a"); return file; });
    const result = await service().downloadAudio(url);
    expect(result.audioPath.endsWith("/audio.m4a")).toBe(true);
    expect(existsSync(result.audioPath)).toBe(true);
    await result.cleanup();
  });

  it("is refused outside that folder, and the folder is removed", async () => {
    let tempDir = "";
    answer(async (dir) => {
      tempDir = dir;
      const file = join(outside, "audio.m4a");
      await writeFile(file, "a");
      return file;
    });
    await expect(service().downloadAudio(url)).rejects.toThrow(he.youtubeDownloadFailed);
    expect(existsSync(tempDir)).toBe(false);
  });

  it("is refused when a link in that folder leads out of it", async () => {
    answer(async (dir) => {
      const target = join(outside, "secret.m4a");
      await writeFile(target, "a");
      const link = join(dir, "audio.m4a");
      await symlink(target, link);
      return link;
    });
    await expect(service().downloadAudio(url)).rejects.toThrow(he.youtubeDownloadFailed);
  });

  it("is refused below that folder", async () => {
    answer(async (dir) => {
      await mkdir(join(dir, "sub"));
      const file = join(dir, "sub", "audio.m4a");
      await writeFile(file, "a");
      return file;
    });
    await expect(service().downloadAudio(url)).rejects.toThrow(he.youtubeDownloadFailed);
  });

  it("is refused when no such file exists", async () => {
    answer(async (dir) => join(dir, "audio.m4a"));
    await expect(service().downloadAudio(url)).rejects.toThrow(he.youtubeDownloadFailed);
  });
});
