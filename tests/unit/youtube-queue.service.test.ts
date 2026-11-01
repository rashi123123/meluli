/* @vitest-environment node */
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntime } from "@main/runtime";
import { YouTubeQueueService } from "@main/services/youtube-queue.service";
vi.mock("electron", () => ({ BrowserWindow: {}, Notification: {} }));

describe("YouTube cancellation", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "meluli-youtube-queue-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it("keeps admission closed until canceled conversion and temporary files settle", async () => {
    const runtime = new AppRuntime();
    let rejectConversion!: (reason: Error) => void;
    let entered!: () => void;
    const converting = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const cleanup = vi.fn(async () => {});
    const transcribeAndStore = vi.fn();
    const queue = new YouTubeQueueService({
      database: { paths: { userDataPath: directory } } as never, runtime,
      youtubeImportService: { downloadAudio: vi.fn(async () => ({ audioPath: "input", sourceUrl: "https://youtube.com/watch?v=test", sourceTitle: "test", durationMs: 1000, cleanup })), cancel: vi.fn(() => false), dispose: vi.fn() } as never,
      audioConverter: { convertInputToWav: vi.fn(async (_input, output, abortSignal) => {
        signal = abortSignal; await writeFile(output, "partial"); entered();
        await new Promise<void>((_resolve, reject) => { rejectConversion = reject; }); return output;
      }) } as never,
      transcriptionService: { cancel: vi.fn(() => false) } as never,
      transcriptionWorkflow: { transcribeAndStore } as never
    });
    queue.initialize(); queue.submit("https://youtube.com/watch?v=test"); await converting;
    expect(queue.cancelActive()).toBe(true); expect(signal?.aborted).toBe(true);
    expect(runtime.getState().status).toBe("youtube_downloading");
    rejectConversion(new Error("aborted")); await queue.waitForSettled();
    expect(runtime.getState().status).toBe("idle");
    expect(transcribeAndStore).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]); expect(queue.cancelActive()).toBe(false);
    await queue.dispose();
  });
});
