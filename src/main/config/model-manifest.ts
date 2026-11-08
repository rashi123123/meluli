import manifest from "@shared/model-manifest.json";

export interface VerifiedModelFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface VerifiedModelManifest {
  id: string;
  revision: string;
  files: readonly VerifiedModelFile[];
}

// Hebrew fine-tune, Apache-2.0. Exact evaluated revision and hashes are shared
// with the development downloader; model weights are never bundled in the app.
export const MODEL_MANIFEST = manifest satisfies VerifiedModelManifest;
