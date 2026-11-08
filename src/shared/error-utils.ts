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

  // Main throws Hebrew messages; an OS strerror for a missing executable can still arrive in English.
  if (normalized.includes("No such file or directory")) {
    return he.whisperMissing;
  }

  return fallback;
}

/**
 * True for the message a canceled transcription reaches the renderer with. Error codes do not survive
 * ipcRenderer.invoke, so the localized message is what both sides share.
 */
export function isCanceledMessage(message: string): boolean {
  return message === he.transcriptionCanceled;
}

export function getHebrewErrorMessage(error: unknown, fallback: string = he.genericError): string {
  if (typeof error === "string") return localizeErrorMessage(error, fallback);
  if (error instanceof Error) {
    return localizeErrorMessage(error.message, fallback);
  }

  return fallback;
}
