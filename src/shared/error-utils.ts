import { he } from "./locale";

const HEBREW_CHARACTERS = /[\u0590-\u05FF]/;

export function localizeErrorMessage(message: string, fallback: string = he.genericError): string {
  // Electron wraps rejected IPC errors with transport details. Show the actual
  // recovery message, without exposing channel names in the interface.
  const normalized = message.trim().replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  if (!normalized) {
    return fallback;
  }

  if (HEBREW_CHARACTERS.test(normalized)) {
    return normalized;
  }

  if (normalized.includes("Transcription canceled.")) {
    return he.transcriptionCanceled;
  }

  if (normalized.includes("No local model is installed.")) {
    return he.localModelMissingError;
  }

  if (
    normalized.includes("whisper-cli sidecar is missing.") ||
    normalized.includes("No such file or directory")
  ) {
    return he.whisperMissing;
  }

  if (normalized.includes("A transcription is already in progress.")) {
    return he.transcriptionAlreadyRunning;
  }

  if (normalized.includes("whisper-cli completed without a transcript result.")) {
    return he.transcriptionEmptyResult;
  }

  if (normalized.includes("whisper-cli exited")) {
    return he.transcriptionProcessFailed;
  }

  if (normalized.includes("Too many redirects while downloading the model.")) {
    return he.modelDownloadRedirectLoop;
  }

  if (normalized.includes("Model download redirect did not include a valid location.")) {
    return he.modelDownloadRedirectFailed;
  }

  if (normalized.includes("Model download failed with status")) {
    return he.modelDownloadFailed;
  }

  if (normalized.includes("Model download produced an empty file.")) {
    return he.modelDownloadEmptyFile;
  }

  if (normalized.includes("Recording was not started.")) {
    return he.recordingNotStarted;
  }

  if (normalized.includes("afconvert exited")) {
    return he.audioConversionFailed;
  }

  if (normalized.includes("yt-dlp exited")) {
    return he.youtubeDownloadFailed;
  }

  if (normalized.includes("YouTube download canceled.")) {
    return he.youtubeCanceled;
  }

  if (normalized.includes("Could not register the global shortcut.")) {
    return he.shortcutRegisterFailed;
  }

  return fallback;
}

export function getHebrewErrorMessage(error: unknown, fallback: string = he.genericError): string {
  if (typeof error === "string") return localizeErrorMessage(error, fallback);
  if (error instanceof Error) {
    return localizeErrorMessage(error.message, fallback);
  }

  return fallback;
}
