import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";
import { YTDLP_BINARY_NAME } from "@shared/constants";

export interface BinaryPaths {
  resourcesBasePath: string;
  whispercppWorkerBinaryPath: string;
  /** The streaming zipformer worker (scripts/build-stream-worker.mjs). */
  sherpaOnnxWorkerBinaryPath?: string;
  ytDlpBinaryPath: string;
  denoBinaryPath: string;
}

/** The bundle's Resources folder when packaged, the checkout's `resources/` in development. */
export function resourcesRoot(electronApp: Pick<App, "isPackaged">): string {
  return electronApp.isPackaged ? process.resourcesPath : join(process.cwd(), "resources");
}

/** The licence notices: in the bundle's Resources when packaged, at the checkout's root in development. */
export function thirdPartyNoticesPath(electronApp: Pick<App, "isPackaged">): string {
  return join(electronApp.isPackaged ? process.resourcesPath : process.cwd(), "THIRD_PARTY_NOTICES.md");
}

export function helperBinary(resourcesBasePath: string, ...parts: string[]): string {
  return join(resourcesBasePath, "bin", ...parts);
}

export function resolveBinaryPaths(electronApp: Pick<App, "isPackaged">): BinaryPaths {
  const resourcesBasePath = resourcesRoot(electronApp);
  return {
    resourcesBasePath,
    whispercppWorkerBinaryPath: helperBinary(resourcesBasePath, "whispercpp", "meluli-asr-worker"),
    sherpaOnnxWorkerBinaryPath: helperBinary(resourcesBasePath, "sherpa-onnx", "meluli-asr-worker"),
    ytDlpBinaryPath: helperBinary(resourcesBasePath, "youtube", YTDLP_BINARY_NAME),
    denoBinaryPath: helperBinary(resourcesBasePath, "youtube", "deno")
  };
}

export function resolveWorkerBinary(binaryPaths: BinaryPaths, workerDir: "whispercpp" | "sherpa-onnx" = "whispercpp"): string {
  const binary = workerDir === "sherpa-onnx" ? binaryPaths.sherpaOnnxWorkerBinaryPath : binaryPaths.whispercppWorkerBinaryPath;
  if (!binary || !existsSync(binary)) throw new Error("רכיב התמלול חסר. יש לבנות או להתקין מחדש את Meluli.");
  return binary;
}
