// Which speech engine the app runs. Whisper is the default: it is the more accurate. The
// streaming zipformer is a choice in settings, faster and lighter with live text, a little less
// accurate (docs/BENCHMARKS.md). Development builds can force one with MELULI_ASR_ENGINE.
import { join } from "node:path";
import { DEFAULT_MODEL_FILENAME, DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION, DEFAULT_MODEL_URL } from "@shared/constants";
import type { TranscriptionBackend } from "@shared/types";
import zipformerManifest from "@shared/zipformer-manifest.json";
import { MODEL_MANIFEST, type VerifiedModelManifest } from "./model-manifest";

export type AsrEngineId = "whisper" | "zipformer";

export interface AsrEngine {
  id: AsrEngineId;
  backend: TranscriptionBackend;
  /** The worker's line protocol version. */
  protocolVersion: number;
  /** The worker binary under resources/bin. */
  workerDir: "whispercpp" | "sherpa-onnx";
  /** Live partials and pause segments while the person speaks. */
  streaming: boolean;
  model: {
    id: string;
    revision: string;
    url: string;
    /** The model's folder under the models directory. */
    fileName: string;
    manifest: VerifiedModelManifest;
    /** What the worker is given as modelPath, from the model's folder. */
    workerPath: (directory: string) => string;
  };
}

export const WHISPER_ENGINE: AsrEngine = {
  id: "whisper", backend: "whispercpp", protocolVersion: 2, workerDir: "whispercpp", streaming: false,
  model: {
    id: DEFAULT_MODEL_ID, revision: DEFAULT_MODEL_REVISION, url: DEFAULT_MODEL_URL, fileName: DEFAULT_MODEL_FILENAME,
    manifest: MODEL_MANIFEST, workerPath: (directory) => directory
  }
};

// CC-BY-4.0 (ivrit.ai); attribution is in THIRD_PARTY_NOTICES.md. Weights are downloaded, never bundled.
export const ZIPFORMER_ENGINE: AsrEngine = {
  id: "zipformer", backend: "sherpa-onnx", protocolVersion: 3, workerDir: "sherpa-onnx", streaming: true,
  model: {
    id: zipformerManifest.id, revision: zipformerManifest.revision, url: "https://huggingface.co/" + zipformerManifest.id,
    fileName: "ivrit-zipformer2-66m-streaming-int8",
    manifest: zipformerManifest satisfies VerifiedModelManifest,
    workerPath: (directory) => join(directory, "sherpa-onnx")
  }
};

/** The engine a new profile starts with. */
export const PRODUCT_ASR_ENGINE = WHISPER_ENGINE;

export const ASR_ENGINES: Record<AsrEngineId, AsrEngine> = { whisper: WHISPER_ENGINE, zipformer: ZIPFORMER_ENGINE };

/**
 * The person's choice in settings. MELULI_ASR_ENGINE overrides it only off the product path:
 * an unpackaged Electron run, or a native development build (the native host passes
 * MELULI_NATIVE_DEVELOPMENT only there).
 */
export function resolveAsrEngine(isPackaged: boolean, chosen: AsrEngineId = PRODUCT_ASR_ENGINE.id, env: NodeJS.ProcessEnv = process.env): AsrEngine {
  const overridable = !isPackaged || env.MELULI_NATIVE_DEVELOPMENT === "1";
  const forced = env.MELULI_ASR_ENGINE;
  if (overridable && (forced === "whisper" || forced === "zipformer")) return ASR_ENGINES[forced];
  return ASR_ENGINES[chosen] ?? PRODUCT_ASR_ENGINE;
}
