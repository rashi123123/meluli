import { dirname, join } from "node:path";
import { fileURLToPath, format } from "node:url";
import type { IpcMainInvokeEvent, Session, WebContents } from "electron";
import { AppError } from "@shared/errors/app-error";
import { ERROR_CODES } from "@shared/errors/error-codes";
import type {
  FilesystemPermissionRequest,
  MediaAccessPermissionRequest,
  OpenExternalPermissionRequest,
  PermissionCheckHandlerHandlerDetails,
  PermissionRequest
} from "electron";
import type { InvokeChannelName } from "./ipc/policy";
import { canWindowRoleAccessChannel } from "./ipc/policy";
import type { AppRuntime, AppWindowRole } from "./runtime";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const FILE_ORIGIN = "file://";
/** The window loads this file and the sender check trusts it, so the two cannot drift apart. */
export const RENDERER_ENTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), "../renderer/index.html");
const WINDOW_ROLE_QUERY_KEY = "window";
const MAX_TEXT_INSERT_LENGTH = 20_000;
const MAX_RECORDING_AUDIO_DURATION_MS = 20 * 60_000;
const MAX_RECORDING_SAMPLE_RATE = 48_000;

export const PRELOAD_SANDBOX_COMPATIBILITY = {
  usesOnlyContextBridgeAndIpcRenderer: true,
  hasNoNodeBuiltInDependency: true,
  hasNoUnrestrictedPreloadAssumptions: true
} as const;

export function canEnableSandboxedPreload(): boolean {
  return Object.values(PRELOAD_SANDBOX_COMPATIBILITY).every(Boolean);
}

export interface RendererSecurityEnvironment {
  isPackaged: boolean;
  devServerUrl: URL | null;
  rendererEntryPath: string;
  allowedOrigins: ReadonlySet<string>;
}

export interface PermissionContext {
  webContents: WebContents | null;
  permission: string;
  requestingOrigin?: string | null;
  embeddingOrigin?: string | null;
  requestingUrl?: string | null;
  securityOrigin?: string | null;
  mediaTypes?: ReadonlyArray<"audio" | "video"> | null;
}

function createSecurityError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(ERROR_CODES.security, message, details);
}

export function resolveDevServerUrl(
  rawUrl: string | undefined | null,
  isPackaged: boolean
): URL | null {
  if (isPackaged || !rawUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createSecurityError("Rejected invalid ELECTRON_RENDERER_URL.", {
      rawUrl
    });
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw createSecurityError("Rejected non-loopback ELECTRON_RENDERER_URL.", {
      rawUrl
    });
  }

  return parsed;
}

export function createRendererSecurityEnvironment(options: {
  isPackaged: boolean;
  rawDevServerUrl?: string | null;
  rendererEntryPath?: string;
}): RendererSecurityEnvironment {
  const devServerUrl = resolveDevServerUrl(options.rawDevServerUrl ?? null, options.isPackaged);

  return {
    isPackaged: options.isPackaged,
    devServerUrl,
    rendererEntryPath: options.rendererEntryPath ?? RENDERER_ENTRY_PATH,
    allowedOrigins: new Set([devServerUrl?.origin ?? FILE_ORIGIN])
  };
}

function safeParseUrl(rawUrl: string | null | undefined): URL | null {
  if (!rawUrl) {
    return null;
  }

  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function normalizeOriginFromParsedUrl(url: URL | null): string | null {
  if (!url) {
    return null;
  }

  if (url.protocol === "file:") {
    return FILE_ORIGIN;
  }

  return url.origin;
}

export function normalizeOriginValue(origin: string | null | undefined, fallbackUrl?: string | null): string | null {
  if (origin && origin !== "null") {
    const parsedOrigin = safeParseUrl(origin);
    if (parsedOrigin) {
      return normalizeOriginFromParsedUrl(parsedOrigin);
    }

    return origin;
  }

  return normalizeOriginFromParsedUrl(safeParseUrl(fallbackUrl ?? null));
}

export function getWindowRoleFromUrl(rawUrl: string | null | undefined): AppWindowRole | null {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed) {
    return null;
  }

  const value = parsed.searchParams.get(WINDOW_ROLE_QUERY_KEY);
  return value === "main" || value === "overlay" || value === "call" ? value : null;
}

export function isTrustedRendererUrl(
  rawUrl: string | null | undefined,
  role: AppWindowRole,
  environment: RendererSecurityEnvironment
): boolean {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed || getWindowRoleFromUrl(rawUrl) !== role) {
    return false;
  }

  if (environment.devServerUrl) {
    return parsed.origin === environment.devServerUrl.origin;
  }

  // Built the way loadFile builds it, which leaves a literal % alone. fileURLToPath would throw on one.
  const entry = new URL(format({ protocol: "file:", slashes: true, pathname: environment.rendererEntryPath }));
  return parsed.protocol === "file:" && parsed.host === "" && parsed.pathname === entry.pathname;
}

export function assertValidIpcSender(
  channel: InvokeChannelName,
  event: IpcMainInvokeEvent,
  runtime: Pick<AppRuntime, "getWindowRoleForWebContents">,
  environment: RendererSecurityEnvironment
): AppWindowRole {
  const senderRole = runtime.getWindowRoleForWebContents(event.sender);
  if (!senderRole) {
    throw createSecurityError("Rejected IPC from unknown window.", {
      channel
    });
  }

  if (!event.senderFrame || event.sender.mainFrame !== event.senderFrame) {
    throw createSecurityError("Rejected IPC from non-main frame.", {
      channel,
      role: senderRole
    });
  }

  if (!isTrustedRendererUrl(event.senderFrame.url, senderRole, environment)) {
    throw createSecurityError("Rejected IPC from untrusted renderer URL.", {
      channel,
      role: senderRole,
      url: event.senderFrame.url
    });
  }

  if (!canWindowRoleAccessChannel(senderRole, channel)) {
    throw createSecurityError("Rejected IPC for disallowed window role.", {
      channel,
      role: senderRole
    });
  }

  return senderRole;
}

function isExactAllowedOrigin(
  origin: string | null | undefined,
  requestingUrl: string | null | undefined,
  environment: RendererSecurityEnvironment
): boolean {
  const normalized = normalizeOriginValue(origin ?? null, requestingUrl ?? null);
  return Boolean(normalized && environment.allowedOrigins.has(normalized));
}

function isTrustedPermissionRequest(
  context: PermissionContext,
  runtime: Pick<AppRuntime, "getWindowRoleForWebContents">,
  environment: RendererSecurityEnvironment,
  allowedRoles: ReadonlySet<AppWindowRole>
): AppWindowRole | null {
  const role = context.webContents ? runtime.getWindowRoleForWebContents(context.webContents) : null;
  if (!role || !allowedRoles.has(role)) {
    return null;
  }

  const frameUrl = context.requestingUrl ?? context.webContents?.getURL() ?? null;
  if (!isTrustedRendererUrl(frameUrl, role, environment)) {
    return null;
  }

  if (!isExactAllowedOrigin(context.requestingOrigin ?? context.securityOrigin, frameUrl, environment)) {
    return null;
  }

  if (context.embeddingOrigin && !isExactAllowedOrigin(context.embeddingOrigin, frameUrl, environment)) {
    return null;
  }

  return role;
}

export function shouldAllowPermissionCheck(
  webContents: WebContents | null,
  permission: string,
  requestingOrigin: string,
  details: PermissionCheckHandlerHandlerDetails,
  runtime: Pick<AppRuntime, "getWindowRoleForWebContents">,
  environment: RendererSecurityEnvironment
): boolean {
  if (permission !== "media" || details.mediaType !== "audio" || !details.isMainFrame) {
    return false;
  }

  return Boolean(
    isTrustedPermissionRequest(
      {
        webContents,
        permission,
        requestingOrigin,
        embeddingOrigin: details.embeddingOrigin ?? null,
        requestingUrl: details.requestingUrl ?? null,
        securityOrigin: details.securityOrigin ?? null,
        mediaTypes: ["audio"]
      },
      runtime,
      environment,
      new Set<AppWindowRole>(["main", "overlay"])
    )
  );
}

export function shouldAllowPermissionRequest(
  webContents: WebContents,
  permission: string,
  details:
    | PermissionRequest
    | FilesystemPermissionRequest
    | MediaAccessPermissionRequest
    | OpenExternalPermissionRequest,
  runtime: Pick<AppRuntime, "getWindowRoleForWebContents">,
  environment: RendererSecurityEnvironment
): boolean {
  if (permission !== "media" || !details.isMainFrame) {
    return false;
  }

  const mediaTypes =
    "mediaTypes" in details && Array.isArray(details.mediaTypes)
      ? details.mediaTypes.filter((value): value is "audio" | "video" => value === "audio" || value === "video")
      : [];

  if (mediaTypes.length !== 1 || mediaTypes[0] !== "audio") {
    return false;
  }

  return Boolean(
    isTrustedPermissionRequest(
      {
        webContents,
        permission,
        requestingOrigin: "securityOrigin" in details ? details.securityOrigin ?? null : null,
        requestingUrl: details.requestingUrl,
        securityOrigin: "securityOrigin" in details ? details.securityOrigin ?? null : null,
        mediaTypes
      },
      runtime,
      environment,
      new Set<AppWindowRole>(["main", "overlay"])
    )
  );
}

export function isAllowedOpenExternalUrl(rawUrl: string): boolean {
  const parsed = safeParseUrl(rawUrl);
  return Boolean(parsed && parsed.protocol === "https:");
}

export function assertSafeTextInsertionInput(text: string): void {
  const normalized = text.trim();
  if (!normalized) {
    throw createSecurityError("Rejected empty text insertion.");
  }

  if (normalized.length > MAX_TEXT_INSERT_LENGTH) {
    throw createSecurityError("Rejected oversized text insertion.", {
      length: normalized.length,
      maxLength: MAX_TEXT_INSERT_LENGTH
    });
  }
}

export function assertSafeRecordingAudioPayload(payload: {
  sampleRate: number;
  durationMs: number;
  pcm: ArrayBuffer | ArrayLike<number>;
}): void {
  const pcm =
    payload.pcm instanceof ArrayBuffer
      ? (() => {
          if (payload.pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
            throw createSecurityError("Rejected invalid audio buffer alignment.", {
              byteLength: payload.pcm.byteLength
            });
          }

          return new Float32Array(payload.pcm);
        })()
      : payload.pcm;

  if (!Number.isFinite(payload.sampleRate) || payload.sampleRate <= 0 || payload.sampleRate > MAX_RECORDING_SAMPLE_RATE) {
    throw createSecurityError("Rejected invalid audio sample rate.", {
      sampleRate: payload.sampleRate
    });
  }

  if (!Number.isFinite(payload.durationMs) || payload.durationMs < 0 || payload.durationMs > MAX_RECORDING_AUDIO_DURATION_MS) {
    throw createSecurityError("Rejected invalid audio duration.", {
      durationMs: payload.durationMs,
      maxDurationMs: MAX_RECORDING_AUDIO_DURATION_MS
    });
  }

  const expectedSamples = Math.ceil((payload.sampleRate * payload.durationMs) / 1000) + payload.sampleRate;
  if (pcm.length > expectedSamples) {
    throw createSecurityError("Rejected oversized audio payload.", {
      sampleRate: payload.sampleRate,
      durationMs: payload.durationMs,
      samples: pcm.length,
      maxSamples: expectedSamples
    });
  }

  // Resampling can overshoot full scale, and the WAV encoder already clamps.
  for (let index = 0; index < pcm.length; index += 1) {
    if (!Number.isFinite(pcm[index])) {
      throw createSecurityError("Rejected non-finite audio sample.", {
        index
      });
    }
  }
}

export function installSessionPermissionHandlers(
  ses: Session,
  runtime: Pick<AppRuntime, "getWindowRoleForWebContents">,
  environment: RendererSecurityEnvironment
): void {
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    shouldAllowPermissionCheck(webContents, permission, requestingOrigin, details, runtime, environment)
  );

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowPermissionRequest(webContents, permission, details, runtime, environment));
  });
}
