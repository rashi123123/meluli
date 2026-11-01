import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { join } from "node:path";
import { experimentalDictationRoot } from "./experimental-dictation.service";

async function verify(path: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error("Research asset hash mismatch: " + path);
}

/** Explicit development-only candidate. Never changes the settings model. */
export function offlineResearchConfig(isPackaged: boolean, profile: string, env = process.env) {
  if (!env.MELULI_OFFLINE_RESEARCH) return null;
  if (isPackaged) throw new Error("Research configuration is unavailable in packaged applications.");
  if (env.MELULI_OFFLINE_RESEARCH !== "q5-beam3") throw new Error("Unknown offline research configuration.");
  experimentalDictationRoot(false, profile, { ...env, MELULI_EXPERIMENTAL_DICTATION: "1" });
  const root = realpathSync(env.MELULI_EXPERIMENT_ASSETS!);
  const model = join(root, "assets/quantized");
  const binary = join(root, "build/native/research-worker");
  let validation: Promise<void> | null = null;
  return {
    binary,
    modelId: "ivrit-turbo-q5_0-beam3@2130c78e4a9cb4914cc4df91a1c3031407789705",
    workerEnv: { MELULI_RESEARCH_MODEL_FILE: "ivrit-turbo-q5_0.bin", MELULI_RESEARCH_BEAM: "3" },
    async getModelPath() {
      validation ??= Promise.all([
        verify(binary, "ee776e1d0fa486d0d3700d2587b7bc9726b4b34583f71b37886d9d7ff301f85b"),
        verify(join(model, "ivrit-turbo-q5_0.bin"), "6c1da92e8e41dd64b8cc402eee7eb7a433d2152567e1a4d9cf181fefcc67a572")
      ]).then(() => undefined);
      await validation;
      return model;
    }
  };
}
