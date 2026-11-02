/* @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appSettingsSchema } from "@shared/schemas";

const speed = (averageSetupMs: number, averageMsPerAudioSecond: number) => ({ sampleCount: 0, averageSetupMs, averageMsPerAudioSecond });
const defaults = {
  microphone: { balanced: speed(7_000, 200), accurate: speed(7_800, 224) },
  imported_file: { balanced: speed(6_500, 180), accurate: speed(7_200, 202) },
  youtube: { balanced: speed(6_500, 180), accurate: speed(7_200, 202) }
};

describe("processing telemetry defaults", () => {
  it("fills every value on an empty settings file", () => {
    expect(appSettingsSchema.parse({}).processingTelemetry).toEqual(defaults);
  });

  it("fills what a partial file leaves out and keeps what it has", () => {
    const measured = speed(1, 2);
    const parsed = appSettingsSchema.parse({ processingTelemetry: { microphone: { balanced: measured } } }).processingTelemetry;
    expect(parsed).toEqual({ ...defaults, microphone: { ...defaults.microphone, balanced: measured } });
    expect(appSettingsSchema.parse({ processingTelemetry: {} }).processingTelemetry).toEqual(defaults);
  });

  it("states each default once, in the telemetry schema", () => {
    expect(readFileSync("src/shared/schemas.ts", "utf8")).toContain("processingTelemetry: processingTelemetrySchema.prefault({}),");
  });
});
