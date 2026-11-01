import { describe, expect, it } from "vitest";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { he } from "@shared/locale";
import { droppedAudioPathSchema } from "@shared/schemas";
import { AppError } from "@shared/errors/app-error";
describe("error messages across renderer callbacks", () => {
  it("shows a validation failure's own message, not the issue list", () => {
    const issue = droppedAudioPathSchema.safeParse("notes.txt").error;
    expect(AppError.fromUnknown(issue).message).toBe(he.importAudioFailed);
  });
  it("preserves a localized string passed by the recording hook", () => {
    expect(getHebrewErrorMessage(he.transcriptionEmptyResult, he.recordingFailed)).toBe(he.transcriptionEmptyResult);
  });
  it("removes Electron transport details from a localized IPC failure", () => {
    expect(getHebrewErrorMessage(new Error(`Error invoking remote method 'recording:send-audio': Error: ${he.audioConversionFailed}`))).toBe(he.audioConversionFailed);
  });
  it("retains Error localization and uses the fallback for unknown values", () => {
    expect(getHebrewErrorMessage(new Error("Transcription canceled."))).toBe(he.transcriptionCanceled);
    expect(getHebrewErrorMessage(null, he.recordingFailed)).toBe(he.recordingFailed);
  });
});
