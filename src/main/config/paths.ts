import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";
import { YTDLP_BINARY_NAME } from "@shared/constants";

export interface BinaryPaths {
  resourcesBasePath: string;
  whispercppWorkerBinaryPath: string;
  ytDlpBinaryPath: string;
  denoBinaryPath: string;
}

export interface WorkerCommand {
  command: string;
  baseArgs: string[];
}

export function resolveBinaryPaths(electronApp: Pick<App, "isPackaged">): BinaryPaths {
  const resourcesBasePath = electronApp.isPackaged
    ? process.resourcesPath
    : join(process.cwd(), "resources");

  return {
    resourcesBasePath,
    whispercppWorkerBinaryPath: join(resourcesBasePath, "bin", "whispercpp", "meluli-asr-worker"),
    ytDlpBinaryPath: join(resourcesBasePath, "bin", "youtube", YTDLP_BINARY_NAME),
    denoBinaryPath: join(resourcesBasePath, "bin", "youtube", "deno")
  };
}

export function resolveWorkerCommand(binaryPaths: BinaryPaths): WorkerCommand {
  if (!existsSync(binaryPaths.whispercppWorkerBinaryPath)) throw new Error("רכיב התמלול חסר. יש לבנות או להתקין מחדש את Meluli.");
  return {
    command: binaryPaths.whispercppWorkerBinaryPath,
    baseArgs: []
  };
}
