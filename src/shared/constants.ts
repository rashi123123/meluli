export const APP_ID = "io.github.rashi123123.meluli";
export const APP_NAME = "Meluli";
// Storage identity is intentionally stable across the Mila → Meluli rename.
declare const __MELULI_OFFICIAL_BUILD__: boolean | undefined;
export const APP_SUPPORT_DIR_NAME = "IvritMenuBar";
export const REPOSITORY_URL = "https://github.com/rashi123123/meluli";
// Only the release workflow's build carries the feed. A build from source has no Developer ID, so its update would be refused.
export const UPDATE_FEED_URL = typeof __MELULI_OFFICIAL_BUILD__ !== "undefined" && __MELULI_OFFICIAL_BUILD__ === true
  ? `${REPOSITORY_URL}/releases/latest/download/releases.json` : "";
export const SUPPORTED_SITES_URL = "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md";
export const AUDIO_IMPORT_EXTENSIONS = ["m4a", "mp3", "wav", "aiff", "aif", "caf"] as const;
export const DEFAULT_SHORTCUT = "Control+Shift+R";
export const DEFAULT_OVERLAY_SHORTCUT = "Control+Shift+H";
export const DEFAULT_TRANSCRIPTION_BACKEND = "whispercpp" as const;
export const DEFAULT_MODEL_ID = "JoaoZaokk/ivrit-whisper-large-v3-turbo-ggml";
export const DEFAULT_MODEL_REVISION = "7caf56da903afb6adf616b56ac4bbe59485e15aa";
export const DEFAULT_MODEL_FILENAME = "ivrit-whisper-large-v3-turbo-q8";
export const DEFAULT_MODEL_WEIGHT_FILE = "ggml-ivrit-whisper-large-v3-turbo-q8_0.bin";
export const DEFAULT_MODEL_URL = "https://huggingface.co/" + DEFAULT_MODEL_ID;
export const YTDLP_BINARY_NAME = "yt-dlp";
export const DEFAULT_WINDOW_SIZE = { width: 1120, height: 720 };
export const MIN_WINDOW_SIZE = { width: 720, height: 560 };
export const TRANSCRIPTS_DIR_NAME = "transcripts";
export const MODELS_DIR_NAME = "models";
export const MAX_RECORDING_DURATION_MS = 20 * 60_000;
/** The highest microphone rate a recording may arrive at. */
export const MAX_RECORDING_SAMPLE_RATE = 48_000;
const RECORDING_LIMIT_WARNING_MS = 60_000;
/** A press this short is an accident, not a dictation. */
export const MIN_DICTATION_MS = 500;
/** A cancel throws away less than this without offering to undo it. */
export const CANCEL_UNDO_MIN_MS = 3_000;
export const CANCEL_UNDO_WINDOW_MS = 6_000;
/** Unsent audio is held in memory this long for a quick retry; the copy on disk stays in History. */
export const HELD_RECORDING_TTL_MS = 10 * 60_000;
/** A transcribed recording's audio is kept this long so it can be transcribed again. */
export const RECORDING_AUDIO_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const isNearRecordingLimit = (elapsedMs: number) => elapsedMs >= MAX_RECORDING_DURATION_MS - RECORDING_LIMIT_WARNING_MS;
// A stored value above these limits fails the whole settings read, so they may only grow.
export const DICTIONARY_MAX_ENTRIES = 500;
export const DICTIONARY_MAX_LENGTH = 64;

/** Built-in term packs in the order the dictionary screen lists them. */
export const TERM_PACK_IDS = ["ai", "dev", "tools", "product", "design", "marketing"] as const;
/** The four packs that made up the single built-in list before packs existed. */
export const DEFAULT_TERM_PACKS: readonly (typeof TERM_PACK_IDS)[number][] = ["ai", "dev", "tools", "product"];

/** Onboarding events kept in settings. The settings schema rejects more, so trimming and schema share this. */
export const MAX_ONBOARDING_TRACKING_EVENTS = 200;

export const SETTINGS_KEYS = {
  onboardingCompleted: "onboarding_completed",
  onboarding: "onboarding",
  onboardingTracking: "onboarding_tracking",
  shortcut: "shortcut",
  overlayShortcut: "overlay_shortcut",
  overlayPosition: "overlay_position",
  microphoneDeviceId: "microphone_device_id",
  completionNotificationsEnabled: "completion_notifications_enabled",
  metalEnabled: "metal_enabled",
  launchAtLogin: "launch_at_login",
  theme: "theme",
  speedPreference: "speed_preference",
  removeFillerWords: "remove_filler_words",
  numbersAsDigits: "numbers_as_digits",
  formatForApp: "format_for_app",
  termPacks: "term_packs",
  dictionary: "dictionary",
  holdKey: "hold_key",
  asrEngine: "asr_engine",
  spokenCommands: "spoken_commands",
  autoUpdate: "auto_update",
  callDetection: "call_detection",
  keepRecordingAudio: "keep_recording_audio",
  flows: "flows",
  flowConnections: "flow_connections",
  processingTelemetry: "processing_telemetry",
  modelState: "model_state"
} as const;

/** The old on/off switch. Read only until termPacks is first saved, and never written. */
export const LEGACY_BUILT_IN_TERMS_KEY = "built_in_terms";
