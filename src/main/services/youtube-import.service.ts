import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { he } from "@shared/locale";
import { isSupportedMediaUrl, youtubeSubmitInputSchema } from "@shared/schemas";

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

export class YouTubeDownloadCanceledError extends Error {
  constructor() {
    super(he.youtubeCanceled);
    this.name = "YouTubeDownloadCanceledError";
  }
}

export function isYouTubeDownloadCanceledError(error: unknown): error is YouTubeDownloadCanceledError {
  return error instanceof YouTubeDownloadCanceledError;
}

/** The optional helper brings its own Deno; never depend on a user's install. */
export function buildYtDlpRuntimeArgs(denoExecutable: string): string[] {
  return ["--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-cache-dir",
    "--no-js-runtimes", "--js-runtimes", `deno:${denoExecutable}`];
}

/** Only what the helper needs: OPENSSL_CONF, PATH entries and the like run code in it. */
export function buildYtDlpEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", DENO_NO_UPDATE_CHECK: "1" };
  for (const key of ["HOME", "TMPDIR", "LANG"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function isLinkImportInstalled(paths: YouTubeImportDependencies): boolean {
  return existsSync(paths.ytDlpBinaryPath) && existsSync(paths.denoBinaryPath);
}

// The generic extractor would fetch any page it is handed, so only known sites run.
// Mediasite matches any host and calls back to it. Check for others when the yt-dlp pin moves.
const ANY_HOST_EXTRACTORS = ["generic", "mediasite", "mediasitecatalog", "mediasitenamedcatalog"];
const SOURCE_ARGS = ["--ies", ["default", ...ANY_HOST_EXTRACTORS.map(name => `-${name}`)].join(","),
  "--no-playlist", "--playlist-items", "1"];
// afconvert decodes these without ffmpeg; webm and opus would download and then fail.
const AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=mp4]/best[ext=m4a]/best[ext=mp3]/best[ext=mp4]";

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
    return new YouTubeDownloadCanceledError();
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

export class YouTubeImportService extends EventEmitter {
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private cancelRequested = false;
  private disposed = false;

  constructor(private readonly dependencies: YouTubeImportDependencies) {
    super();
  }

  private get useMockMode(): boolean {
    return process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1";
  }

  dispose(): void { this.disposed = true; this.cancel(); }

  async downloadAudio(url: string, signal?: AbortSignal): Promise<YouTubeDownloadResult> {
    signal?.throwIfAborted();
    const abort = () => { this.cancel(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.downloadAudioInternal(url, signal);
      if (signal?.aborted) {
        await result.cleanup();
        throw new YouTubeDownloadCanceledError();
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async downloadAudioInternal(url: string, signal?: AbortSignal): Promise<YouTubeDownloadResult> {
    if (this.disposed) throw new Error(he.transcriptionCanceled);
    const parsed = youtubeSubmitInputSchema.parse({ url });

    if (this.useMockMode) {
      const tempDir = await mkdtemp(join(tmpdir(), "ivrit-youtube-mock-"));
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

    this.emit("progress", { stage: "metadata" });
    const metadataResult = await this.runProcess(buildYtDlpMetadataArgs(parsed.url));
    signal?.throwIfAborted();
    const metadata = parseMetadata(metadataResult.stdout);
    const tempDir = await mkdtemp(join(tmpdir(), "ivrit-youtube-"));
    const outputTemplate = join(tempDir, "audio.%(ext)s");

    try {
      signal?.throwIfAborted();
      this.emit("progress", { stage: "downloading" });
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
        audioPath,
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
    const didSignal = child.kill("SIGTERM");
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
    timeout.unref();
    child.once("close", () => clearTimeout(timeout));
    if (!didSignal) {
      this.cancelRequested = false;
    }
    return didSignal;
  }

  private runProcess(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.disposed) return Promise.reject(new Error(he.transcriptionCanceled));
    return new Promise((resolve, reject) => {
      const child = spawn(this.dependencies.ytDlpBinaryPath,
        [...buildYtDlpRuntimeArgs(this.dependencies.denoBinaryPath), ...args], {
          env: buildYtDlpEnv(process.env)
        });
      this.activeProcess = child;
      this.cancelRequested = false;

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
          child.kill("SIGTERM");
          finish(() => reject(new Error(he.youtubeImportFailed)));
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });

      child.on("error", (error) => {
        this.activeProcess = null;
        this.cancelRequested = false;
        finish(() => reject(error));
      });

      child.on("close", (code, signal) => {
        this.activeProcess = null;
        const canceled = this.cancelRequested;
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
