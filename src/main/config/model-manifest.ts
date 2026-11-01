import manifest from "@shared/model-manifest.json";
import type { VerifiedModelManifest } from "../services/verified-download";

// Hebrew fine-tune, Apache-2.0. Exact evaluated revision and hashes are shared
// with the development downloader; model weights are never bundled in the app.
export const MODEL_MANIFEST = manifest satisfies VerifiedModelManifest;
