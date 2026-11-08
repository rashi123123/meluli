/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { resolveWorkerBinary, type BinaryPaths } from "@main/config/paths";
const paths: BinaryPaths = { resourcesBasePath: "/missing", whispercppWorkerBinaryPath: "/missing/meluli-asr-worker", ytDlpBinaryPath: "/missing/yt-dlp", denoBinaryPath: "/missing/yt-dlp" };
describe("standalone packaged worker", () => {
  it("rejects a missing Whisper runtime without falling back to another engine", () => {
    expect(() => resolveWorkerBinary(paths)).toThrow("חסר");
  });
  it("uses the bundled binary without script arguments", () => {
    expect(resolveWorkerBinary({ ...paths, whispercppWorkerBinaryPath: process.execPath })).toBe(process.execPath);
  });
});
