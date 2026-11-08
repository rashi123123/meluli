import * as z from "zod";
import type { AppSettings } from "./types";
import { DEFAULT_THEME, THEME_IDS } from "./themes";
import { flowConnectionsSettingSchema, flowsSettingSchema } from "./flows";
import {
  AUDIO_IMPORT_EXTENSIONS,
  MAX_ONBOARDING_TRACKING_EVENTS,
  DEFAULT_MODEL_FILENAME,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_URL,
  DEFAULT_OVERLAY_SHORTCUT,
  DEFAULT_SHORTCUT,
  DICTIONARY_MAX_ENTRIES,
  DICTIONARY_MAX_LENGTH,
  DEFAULT_TERM_PACKS,
  MAX_RECORDING_SAMPLE_RATE,
  TERM_PACK_IDS
} from "./constants";
import { he } from "./locale";
import { createDefaultOnboardingState, createDefaultOnboardingTrackingState } from "./onboarding-defaults";

/** The hold-to-talk key; native/HoldKey.swift takes the same names. */
export const holdKeyChoiceSchema = z.enum(["off", "right_option", "right_command"]);
/** Whisper (accurate) or the streaming zipformer (fast and light, live text). */
export const asrEngineSchema = z.enum(["whisper", "zipformer"]);

export const transcriptSourceSchema = z.enum(["microphone", "imported_file", "youtube", "call"]);
export const transcriptionBackendSchema = z.enum(["ct2", "whispercpp", "nemo", "sherpa-onnx"]);
export const speedPreferenceSchema = z.enum(["accurate", "balanced"]);
export const themeSchema = z.enum(THEME_IDS);
export const modelDownloadStateSchema = z.enum(["missing", "downloading", "ready", "error"]);
export const onboardingPhaseSchema = z.enum(["not_started", "needs_mic", "needs_hold_key", "needs_paste", "needs_model", "needs_first_transcript", "activated"]);
export const onboardingSurfaceSchema = z.enum(["flow", "workspace"]);
export const onboardingStepKeySchema = z.enum(["ready", "microphone", "hold_key", "paste", "local_install", "first_transcript", "celebration"]);
export const onboardingOptionalActionSchema = z.enum(["recording_shortcut", "overlay_accessibility"]);
export const onboardingTrackingEventNameSchema = z.enum([
  "onboarding_started",
  "onboarding_step_viewed",
  "onboarding_step_completed",
  "onboarding_step_exited",
  "first_transcript_started",
  "first_transcript_completed",
  "optional_step_completed",
  "optional_step_dismissed",
  "secondary_source_selected"
]);

const LOCAL_HOST = /(^localhost$|\.(localhost|local|internal|intranet|lan|home|test|home\.arpa)$)/u;

/** A public https page, for yt-dlp to match against its site list. YouTube keeps its single-video rule. */
export function isSupportedMediaUrl(value: string): boolean {
  try {
    // A backslash or space reads as a different host in yt-dlp than it does here.
    const trimmed = value.trim();
    if (/[\\\s]/u.test(trimmed)) return false;
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (!host.includes(".") || host.includes(":") || /^[\d.]+$/u.test(host) || LOCAL_HOST.test(host)) return false;
    return /(^|\.)(youtube\.com|youtu\.be)$/u.test(host) ? isSupportedYouTubeUrl(value) : true;
  } catch {
    return false;
  }
}

export function isSupportedYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^www\./u, "");

    if (host === "youtu.be") {
      return url.pathname.length > 1 && !url.searchParams.has("list");
    }

    if (!["youtube.com", "m.youtube.com"].includes(host)) {
      return false;
    }

    if (url.pathname === "/watch") {
      return url.searchParams.has("v") && !url.searchParams.has("list");
    }

    if (url.pathname.startsWith("/shorts/")) {
      const id = url.pathname.split("/").filter(Boolean)[1];
      return Boolean(id) && !url.searchParams.has("list");
    }

    return false;
  } catch {
    return false;
  }
}

export const overlayPositionSchema = z.enum(["last", "top", "bottom", "right", "left", "top-right", "top-left", "bottom-right", "bottom-left"]);

export const clipboardTextSchema = z.string().min(1).max(4_000_000);

export const droppedAudioPathSchema = z.string().refine(
  path => path.startsWith("/") && AUDIO_IMPORT_EXTENSIONS.some(extension => path.toLowerCase().endsWith(`.${extension}`)),
  he.importAudioFailed
);

export const youtubeSubmitInputSchema = z.object({
  url: z
    .string()
    .trim()
    .url(he.youtubeInvalidUrl)
    .refine(isSupportedMediaUrl, he.youtubeInvalidUrl)
    .transform(value => new URL(value).href)
});

const processingTelemetryBucketSchema = z.object({
  sampleCount: z.number().int().nonnegative().prefault(0),
  averageSetupMs: z.number().nonnegative().prefault(7_000),
  averageMsPerAudioSecond: z.number().nonnegative().prefault(200)
});

const processingTelemetrySpeedMapSchema = z.object({
  balanced: processingTelemetryBucketSchema.prefault({
    sampleCount: 0,
    averageSetupMs: 7_000,
    averageMsPerAudioSecond: 200
  }),
  accurate: processingTelemetryBucketSchema.prefault({
    sampleCount: 0,
    averageSetupMs: 7_800,
    averageMsPerAudioSecond: 224
  })
});

export const processingTelemetrySchema = z.object({
  microphone: processingTelemetrySpeedMapSchema.prefault({
    balanced: {
      sampleCount: 0,
      averageSetupMs: 7_000,
      averageMsPerAudioSecond: 200
    },
    accurate: {
      sampleCount: 0,
      averageSetupMs: 7_800,
      averageMsPerAudioSecond: 224
    }
  }),
  imported_file: processingTelemetrySpeedMapSchema.prefault({
    balanced: {
      sampleCount: 0,
      averageSetupMs: 6_500,
      averageMsPerAudioSecond: 180
    },
    accurate: {
      sampleCount: 0,
      averageSetupMs: 7_200,
      averageMsPerAudioSecond: 202
    }
  }),
  youtube: processingTelemetrySpeedMapSchema.prefault({
    balanced: {
      sampleCount: 0,
      averageSetupMs: 6_500,
      averageMsPerAudioSecond: 180
    },
    accurate: {
      sampleCount: 0,
      averageSetupMs: 7_200,
      averageMsPerAudioSecond: 202
    }
  })
});

export const transcriptRecordSchema = z.object({
  id: z.string(),
  createdAt: z.number().int(),
  sourceType: transcriptSourceSchema,
  text: z.string(),
  rawText: z.string().nullable().optional(),
  paragraphs: z.array(z.string()).nullable().optional(),
  importedFileName: z.string().nullable().optional(),
  sourceTitle: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  possibleTerms: z.array(z.string()).nullable().optional(),
  uncertainSegments: z.array(z.string()).nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  backend: transcriptionBackendSchema.nullable().optional(),
  modelId: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  segments: z.array(
    z.object({
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
      text: z.string(),
      speaker: z.enum(["me", "others"]).optional()
    })
  ).nullable().optional(),
  editedAt: z.number().int().nullable().optional()
});

export const modelStateSchema = z.object({
  id: z.string().prefault(DEFAULT_MODEL_ID),
  url: z.string().url().prefault(DEFAULT_MODEL_URL),
  fileName: z.string().prefault(DEFAULT_MODEL_FILENAME),
  filePath: z.string().nullable(),
  downloadState: modelDownloadStateSchema.prefault("missing"),
  bytesDownloaded: z.number().int().nonnegative().prefault(0),
  totalBytes: z.number().int().positive().nullable().prefault(null),
  lastError: z.string().nullable().optional()
});

export const onboardingStateSchema = z.object({
  phase: onboardingPhaseSchema.prefault("not_started"),
  surface: onboardingSurfaceSchema.prefault("flow"),
  activatedAt: z.number().int().nullable().prefault(null),
  completedOptionalActions: z.array(onboardingOptionalActionSchema).prefault([]),
  dismissedOptionalActions: z.array(onboardingOptionalActionSchema).prefault([])
});

export const onboardingTrackingEventSchema = z.object({
  name: onboardingTrackingEventNameSchema,
  occurredAt: z.number().int(),
  phase: onboardingPhaseSchema.nullable(),
  step: onboardingStepKeySchema.nullable(),
  sourceType: transcriptSourceSchema.nullable(),
  optionalAction: onboardingOptionalActionSchema.nullable()
});

export const onboardingTrackingStateSchema = z.object({
  events: z.array(onboardingTrackingEventSchema).max(MAX_ONBOARDING_TRACKING_EVENTS).prefault([])
});

const dictionaryEntrySchema = z.object({
  id: z.string().min(1).max(64),
  heard: z.string().trim().min(1).max(DICTIONARY_MAX_LENGTH),
  written: z.string().trim().min(1).max(DICTIONARY_MAX_LENGTH)
});

const appSettingsInputSchema = z.object({
  onboardingCompleted: z.boolean().prefault(false),
  onboarding: onboardingStateSchema.optional(),
  onboardingTracking: onboardingTrackingStateSchema.prefault(createDefaultOnboardingTrackingState()),
  shortcut: z.string().prefault(DEFAULT_SHORTCUT),
  overlayShortcut: z.string().prefault(DEFAULT_OVERLAY_SHORTCUT),
  overlayPosition: overlayPositionSchema.prefault("last"),
  microphoneDeviceId: z.string().nullable().prefault(null),
  completionNotificationsEnabled: z.boolean().prefault(true),
  metalEnabled: z.boolean().prefault(true),
  launchAtLogin: z.boolean().prefault(false),
  theme: themeSchema.prefault(DEFAULT_THEME),
  speedPreference: speedPreferenceSchema.prefault("balanced"),
  removeFillerWords: z.boolean().prefault(true),
  numbersAsDigits: z.boolean().prefault(true),
  formatForApp: z.boolean().prefault(true),
  termPacks: z.array(z.string()).optional(),
  /** Stored before packs existed: off meant no built-in terms at all. */
  builtInTerms: z.boolean().optional(),
  dictionary: z.array(dictionaryEntrySchema).max(DICTIONARY_MAX_ENTRIES).prefault([]),
  holdKey: holdKeyChoiceSchema.prefault("right_option"),
  asrEngine: asrEngineSchema.prefault("whisper"),
  spokenCommands: z.boolean().prefault(true),
  autoUpdate: z.boolean().prefault(true),
  callDetection: z.boolean().prefault(false),
  keepRecordingAudio: z.boolean().prefault(true),
  flows: flowsSettingSchema.prefault([]),
  flowConnections: flowConnectionsSettingSchema.prefault([]),
  processingTelemetry: processingTelemetrySchema.prefault({}),
  modelState: modelStateSchema.prefault({
    id: DEFAULT_MODEL_ID,
    url: DEFAULT_MODEL_URL,
    fileName: DEFAULT_MODEL_FILENAME,
    filePath: null,
    downloadState: "missing",
    bytesDownloaded: 0,
    totalBytes: null
  })
});

export const appSettingsSchema = appSettingsInputSchema.transform((input) => {
  const phase = input.onboarding?.phase ?? (input.onboardingCompleted ? "activated" : "not_started");
  const onboarding = onboardingStateSchema.parse({
    ...createDefaultOnboardingState(phase === "activated"),
    ...input.onboarding,
    phase,
    surface: input.onboarding?.surface ?? (phase === "activated" ? "workspace" : "flow"),
    activatedAt: phase === "activated" ? input.onboarding?.activatedAt ?? null : null
  });

  const { builtInTerms, termPacks: storedPacks, ...rest } = input;
  const termPacks = storedPacks
    ? TERM_PACK_IDS.filter((id) => storedPacks.includes(id))
    : builtInTerms === false ? [] : [...DEFAULT_TERM_PACKS];

  return {
    ...rest,
    termPacks,
    onboardingCompleted: phase === "activated",
    onboarding,
    onboardingTracking: onboardingTrackingStateSchema.parse(input.onboardingTracking)
  };
});

const isFloat32ArrayLike = (value: unknown): value is Float32Array =>
  value instanceof Float32Array || Object.prototype.toString.call(value) === "[object Float32Array]";
const isArrayBufferLike = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";

export const recordingAudioPayloadSchema = z.object({
  pcm: z.custom<number[] | Float32Array | ArrayBuffer>(
    (value) => Array.isArray(value) || isFloat32ArrayLike(value) || isArrayBufferLike(value),
    {
      message: "Expected PCM payload to be a number array, Float32Array, or ArrayBuffer."
    }
  ),
  sampleRate: z.number().positive(),
  durationMs: z.number().nonnegative(),
  capturedAt: z.object({ micReady: z.number(), stopped: z.number() }).optional(),
  flushIncomplete: z.literal(true).optional(),
  recordingId: z.uuid().optional()
});

/** About a second of audio, written to disk while the recording goes on. */
export const recordingAudioChunkSchema = z.object({
  recordingId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  sampleRate: z.number().int().positive().max(MAX_RECORDING_SAMPLE_RATE),
  pcm: z.custom<Float32Array | ArrayBuffer>((value) => isFloat32ArrayLike(value) || isArrayBufferLike(value), {
    message: "Expected PCM chunk to be a Float32Array or ArrayBuffer."
  })
});

export const recordingStopInputSchema = z
  .object({
    recordingId: z.uuid().optional(),
    /** The recording was cut short, not thrown away, so what was written of it stays. */
    keepAudio: z.boolean().optional()
  })
  .optional();

export const storedRecordingInputSchema = z.object({ id: z.uuid() });

export const recordingStartInputSchema = z.object({
  startedAt: z.number().int()
});

export const recordingPauseInputSchema = z.object({
  elapsedMs: z.number().nonnegative()
});

export const transcriptListQuerySchema = z.object({
  limit: z.number().int().positive().max(100).prefault(20),
  cursor: z.number().int().nullable().prefault(null)
});

export const transcriptSearchQuerySchema = transcriptListQuerySchema.extend({
  query: z.string().trim().prefault("")
});

export const transcriptDeleteSchema = z.object({
  id: z.string()
});

export const transcriptUpdateSchema = z.union([
  z.strictObject({ id: z.string(), text: z.string().trim().min(1).max(2_000_000) }),
  z.strictObject({ id: z.string(), cueTexts: z.array(z.string().max(20_000)).min(1).max(100_000) })
]);

export const transcriptRestoreSchema = z.object({
  id: z.string()
});

export const transcriptExportSchema = z.object({
  id: z.string(),
  /** Where the export menu opens, in window coordinates. */
  anchor: z.object({ x: z.number().int().min(0).max(100_000), y: z.number().int().min(0).max(100_000) }).optional()
});

/** Every setting the renderer may write; `satisfies` keeps the list inside AppSettings. */
const SETTING_UPDATE_KEYS = [
    "onboardingCompleted",
    "onboarding",
    "onboardingTracking",
    "shortcut",
    "overlayShortcut",
    "overlayPosition",
    "microphoneDeviceId",
    "completionNotificationsEnabled",
    "metalEnabled",
    "launchAtLogin",
    "theme",
    "speedPreference",
    "removeFillerWords",
    "numbersAsDigits",
    "formatForApp",
    "termPacks",
    "dictionary",
    "holdKey",
    "asrEngine",
    "spokenCommands",
    "autoUpdate",
    "callDetection",
    "keepRecordingAudio",
    "processingTelemetry",
    "modelState"
] as const satisfies readonly (keyof AppSettings)[];

export const settingUpdateSchema = z.object({
  key: z.enum(SETTING_UPDATE_KEYS),
  value: z.unknown()
});

export const microphonePermissionStatusSchema = z.enum([
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "unknown"
]);

export const modelDownloadProgressSchema = z.object({
  bytesDownloaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive().nullable(),
  percent: z.number().min(0).max(100).nullable()
});

export const transcriptionErrorPayloadSchema = z.object({
  message: z.string()
});

export const overlaySizeSchema = z.enum(["compact", "expanded"]);
export const mainViewSchema = z.enum(["workspace", "history", "dictionary", "flows", "settings", "about", "terms", "privacy"]);
export const mainWindowReportSchema = z.object({ view: mainViewSchema, keep: z.boolean() }).strict();
