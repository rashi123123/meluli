import { terminateChild } from "../terminate-child";
import { TranscriptionCanceledError } from "../transcription-errors";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { he } from "@shared/locale";
import { isSupportedMediaUrl, youtubeSubmitInputSchema } from "@shared/schemas";
import { isMockMode } from "../../config/mock-mode";
import { minimalChildEnv } from "../child-env";
import { LINK_DOWNLOAD_PREFIX } from "../orphan-audio";

export interface YouTubeImportDependencies {
  ytDlpBinaryPath: string;
  denoBinaryPath: string;
}

export interface YouTubeDownloadResult {
  audioPath: string;
  sourceTitle: string;
  sourceUrl: string;
  durationMs: number | null;
  cleanup: () => Promise<void>;
}

interface YouTubeMetadata {
  title?: string;
  webpage_url?: string;
  duration?: number | null;
}


/** The optional helper brings its own Deno; never depend on a user's install. */
export function buildYtDlpRuntimeArgs(denoExecutable: string): string[] {
  return ["--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-cache-dir",
    "--no-js-runtimes", "--js-runtimes", `deno:${denoExecutable}`];
}

/** yt-dlp runs Deno for some sites; Deno must not reach the network to look for its own updates. */
export function buildYtDlpEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return minimalChildEnv(source, { DENO_NO_UPDATE_CHECK: "1" });
}

export function isLinkImportInstalled(paths: YouTubeImportDependencies): boolean {
  return existsSync(paths.ytDlpBinaryPath) && existsSync(paths.denoBinaryPath);
}

// The generic extractor would fetch any page it is handed, so only known sites run.
// Mediasite matches any host and calls back to it. Check for others when the yt-dlp pin moves.
const ANY_HOST_EXTRACTORS = ["generic", "mediasite", "mediasitecatalog", "mediasitenamedcatalog"];
// YouTube's HLS manifest request can stall for minutes with no answer (measured 2026-11-06 on
// yt-dlp 2026.10.21), and none of AUDIO_FORMAT's choices needs it. A stalled read fails after
// the socket timeout instead of holding the import until the process deadline.
const SOURCE_ARGS = ["--ies", ["default", ...ANY_HOST_EXTRACTORS.map(name => `-${name}`)].join(","),
  "--no-playlist", "--playlist-items", "1", "--extractor-args", "youtube:skip=hls", "--socket-timeout", "30"];
// afconvert decodes these without ffmpeg; webm and opus would download and then fail.
const AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=mp4]/best[ext=m4a]/best[ext=mp3]/best[ext=mp4]";

// An outer bound against a stuck source, not a quota. A very long recording should still fit.
const PROCESS_DEADLINE_MS = 6 * 60 * 60_000;

/** The path comes from the helper's output, so it counts only as a file directly in the import's own folder. */
async function confineToFolder(reportedPath: string, folder: string): Promise<string> {
  const [file, root] = await Promise.all([realpath(reportedPath), realpath(folder)]).catch(() => {
    throw new Error(he.youtubeDownloadFailed);
  });
  if (dirname(file) !== root) throw new Error(he.youtubeDownloadFailed);
  return file;
}

export function buildYtDlpMetadataArgs(url: string): string[] {
  return ["--dump-single-json", "--skip-download", ...SOURCE_ARGS, "--no-warnings", url];
}

export function buildYtDlpDownloadArgs(url: string, outputTemplate: string): string[] {
  return [
    ...SOURCE_ARGS,
    "--no-warnings",
    "--no-progress",
    "--max-filesize",
    "2G",
    "--print",
    "after_move:filepath",
    "-f",
    AUDIO_FORMAT,
    "-o",
    outputTemplate,
    url
  ];
}

export function buildYtDlpProcessError({
  signal,
  canceled,
  stderr = ""
}: {
  signal: NodeJS.Signals | null;
  canceled: boolean;
  stderr?: string;
}): Error {
  if (canceled) {
    return new TranscriptionCanceledError();
  }

  if (!signal && /Unsupported URL|No suitable extractor/u.test(stderr)) {
    return new Error(he.linkUnsupportedSite);
  }

  return new Error(he.youtubeDownloadFailed);
}

function parseMetadata(rawJson: string): YouTubeMetadata {
  const parsed = JSON.parse(rawJson) as YouTubeMetadata;
  const webpageUrl = parsed.webpage_url?.trim();
  return {
    title: parsed.title?.trim() || undefined,
    // The site chooses this value, and it is shown and kept with the transcript.
    webpage_url: webpageUrl && isSupportedMediaUrl(webpageUrl) ? webpageUrl : undefined,
    duration: typeof parsed.duration === "number" ? parsed.duration : null
  };
}

export class YouTubeImportService {
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private cancelRequested = false;
  private disposed = false;

  constructor(private readonly dependencies: YouTubeImportDependencies) {}

  dispose(): void { this.disposed = true; this.cancel(); }

  async downloadAudio(url: string, signal?: AbortSignal): Promise<YouTubeDownloadResult> {
    signal?.throwIfAborted();
    const abort = () => { this.cancel(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.downloadAudioInternal(url, signal);
      if (signal?.aborted) {
        await result.cleanup();
        throw new TranscriptionCanceledError();
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async downloadAudioInternal(url: string, signal?: AbortSignal): Promise<YouTubeDownloadResult> {
    if (this.disposed) throw new TranscriptionCanceledError();
    const parsed = youtubeSubmitInputSchema.parse({ url });

    if (isMockMode()) {
      const tempDir = await mkdtemp(join(tmpdir(), `${LINK_DOWNLOAD_PREFIX}mock-`));
      const mockPath = join(tempDir, "audio.m4a");
      await writeFile(mockPath, "mock youtube audio", "utf8");
      return {
        audioPath: mockPath,
        sourceTitle: he.youtubeMockTitle,
        sourceUrl: parsed.url,
        durationMs: 90_000,
        cleanup: () => rm(tempDir, { recursive: true, force: true })
      };
    }

    if (!isLinkImportInstalled(this.dependencies)) {
      throw new Error(he.youtubeDownloaderMissing);
    }

    if (this.activeProcess) {
      throw new Error(he.youtubeImportAlreadyRunning);
    }

    const metadataResult = await this.runProcess(buildYtDlpMetadataArgs(parsed.url));
    signal?.throwIfAborted();
    const metadata = parseMetadata(metadataResult.stdout);
    const tempDir = await mkdtemp(join(tmpdir(), LINK_DOWNLOAD_PREFIX));
    const outputTemplate = join(tempDir, "audio.%(ext)s");

    try {
      signal?.throwIfAborted();
      const downloadResult = await this.runProcess(buildYtDlpDownloadArgs(parsed.url, outputTemplate));
      const audioPath = downloadResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!audioPath) {
        throw new Error(he.youtubeDownloadFailed);
      }

      return {
        audioPath: await confineToFolder(audioPath, tempDir),
        sourceTitle: metadata.title ?? he.youtubeFallbackTitle,
        sourceUrl: metadata.webpage_url ?? parsed.url,
        durationMs: metadata.duration ? Math.round(metadata.duration * 1000) : null,
        cleanup: () => rm(tempDir, { recursive: true, force: true })
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  cancel(): boolean {
    if (!this.activeProcess) {
      return false;
    }

    this.cancelRequested = true;
    const child = this.activeProcess;
    const didSignal = terminateChild(child);
    if (!didSignal) {
      this.cancelRequested = false;
    }
    return didSignal;
  }

  private runProcess(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.disposed) return Promise.reject(new TranscriptionCanceledError());
    return new Promise((resolve, reject) => {
      const child = spawn(this.dependencies.ytDlpBinaryPath,
        [...buildYtDlpRuntimeArgs(this.dependencies.denoBinaryPath), ...args], {
          env: buildYtDlpEnv(process.env)
        });
      this.activeProcess = child;
      this.cancelRequested = false;

      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        this.cancel();
      }, PROCESS_DEADLINE_MS);
      deadline.unref();

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (handler: () => Promise<void> | void) => {
        if (settled) {
          return;
        }
        settled = true;
        void handler();
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 4 * 1024 * 1024) {
          terminateChild(child);
          finish(() => reject(new Error(he.youtubeImportFailed)));
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });

      child.on("error", (error) => {
        clearTimeout(deadline);
        this.activeProcess = null;
        this.cancelRequested = false;
        finish(() => reject(error));
      });

      child.on("close", (code, signal) => {
        clearTimeout(deadline);
        this.activeProcess = null;
        const canceled = this.cancelRequested && !timedOut;
        this.cancelRequested = false;

        finish(() => {
          if (code !== 0 || signal) {
            reject(buildYtDlpProcessError({ signal, canceled, stderr }));
            return;
          }

          resolve({ stdout, stderr });
        });
      });
    });
  }
}
