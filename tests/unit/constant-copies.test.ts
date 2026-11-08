/* @vitest-environment node */
// Values written twice, in code and in a manifest or in copy, with nothing else tying them together.
import { describe, expect, it } from "vitest";
import manifest from "@shared/model-manifest.json";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION, DEFAULT_MODEL_WEIGHT_FILE, MAX_RECORDING_DURATION_MS } from "@shared/constants";
import { he } from "@shared/locale";

describe("copies of one value", () => {
  it("names the same model as the verified manifest", () => {
    expect(DEFAULT_MODEL_ID).toBe(manifest.id);
    expect(DEFAULT_MODEL_REVISION).toBe(manifest.revision);
    expect(DEFAULT_MODEL_WEIGHT_FILE).toBe(manifest.files[0]?.path);
  });
  it("tells the recording limit the app enforces", () => {
    const minutes = MAX_RECORDING_DURATION_MS / 60_000;
    expect(Number.isInteger(minutes)).toBe(true);
    expect(he.recordingLimitSoon).toContain(`${minutes}:00`);
    expect(he.recordingLimitReached).toContain(`${minutes} דקות`);
  });
});
