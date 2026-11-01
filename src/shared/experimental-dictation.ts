import { z } from "zod";

export interface DictationPreview {
  sessionId: string;
  text: string;
  stableText: string;
  audioSamples: number;
  decodedSamples: number;
  error?: string;
}

export const dictationChunkSchema = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  pcm: z.instanceof(Float32Array).refine(
    value => value.length > 0 && value.length <= 16_000 && value.every(Number.isFinite),
    "Invalid experimental audio chunk"
  )
});
