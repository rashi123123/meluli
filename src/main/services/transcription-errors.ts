import { he } from "@shared/locale";

/** The one way a transcription, conversion or import says it was canceled. */
export class TranscriptionCanceledError extends Error {
  constructor() {
    super(he.transcriptionCanceled);
    this.name = "TranscriptionCanceledError";
  }
}

export function isTranscriptionCanceledError(error: unknown): error is TranscriptionCanceledError {
  return error instanceof TranscriptionCanceledError;
}
