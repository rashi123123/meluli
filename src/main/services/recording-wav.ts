import { Worker } from "node:worker_threads";
import { he } from "@shared/locale";
import type { RecordingAudioPayload } from "@shared/types";
import { markPerformanceAudit } from "../diagnostics/perf-audit";
import { TranscriptionCanceledError } from "./transcription-errors";

const WAV_ENCODER_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");

function encodeWavFromFloat32Buffer(pcmBuffer, sampleRate) {
  const pcm = new Float32Array(pcmBuffer);
  const wavBuffer = new ArrayBuffer(44 + pcm.length * 2);
  const buffer = Buffer.from(wavBuffer);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcm.length * 2, 40);

  // Samples through a typed view: every Mac is little-endian, as WAV is. Math.floor(x + 0.5) is
  // Math.round, and the result is byte for byte what writeInt16LE gave, about five times faster.
  const samples = new Int16Array(wavBuffer, 44, pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    const value = pcm[index] || 0;
    samples[index] = Math.floor((value > 1 ? 1 : value < -1 ? -1 : value) * 0x7fff + 0.5);
  }
  return wavBuffer;
}

parentPort.on("message", ({ pcmBuffer, sampleRate }) => {
  try {
    if (!(pcmBuffer instanceof ArrayBuffer)) {
      throw new Error("Expected audio PCM as an ArrayBuffer.");
    }

    const wavBuffer = encodeWavFromFloat32Buffer(pcmBuffer, sampleRate);
    parentPort.postMessage({ wavBuffer }, [wavBuffer]);
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
`;

export function normalizeRecordingPcm(pcm: RecordingAudioPayload["pcm"]): Float32Array {
  if (pcm instanceof Float32Array) {
    return pcm;
  }

  if (pcm instanceof ArrayBuffer) {
    return new Float32Array(pcm);
  }

  return Float32Array.from(pcm);
}

function toTransferableArrayBuffer(view: Float32Array): ArrayBuffer {
  if (view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer;
  }

  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

export async function encodeWavFromRecordingPayload(payload: RecordingAudioPayload, signal: AbortSignal): Promise<Buffer> {
  markPerformanceAudit("recording-audio:encode:start", {
    durationMs: Math.round(payload.durationMs),
    sampleRate: payload.sampleRate
  });
  const pcmBuffer = toTransferableArrayBuffer(normalizeRecordingPcm(payload.pcm));

  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(WAV_ENCODER_WORKER_SOURCE, { eval: true });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const aborted = () => settleWithError(new TranscriptionCanceledError());
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", aborted); };

    const settleWithError = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      void worker.terminate();
      reject(error);
    };

    worker.once("message", (message: { wavBuffer?: ArrayBuffer; error?: string }) => {
      if (settled) {
        return;
      }

      if (message.error) {
        settleWithError(new Error(message.error));
        return;
      }

      if (!(message.wavBuffer instanceof ArrayBuffer)) {
        settleWithError(new Error("Worker returned an invalid WAV buffer."));
        return;
      }

      settled = true;
      cleanup();
      void worker.terminate();
      markPerformanceAudit("recording-audio:encode:end", {
        wavBytes: message.wavBuffer.byteLength
      });
      resolve(Buffer.from(message.wavBuffer));
    });

    worker.once("error", (error) => {
      settleWithError(error);
    });

    worker.once("exit", (code) => {
      if (!settled) {
        settleWithError(new Error(`WAV encoder worker exited with code ${code}.`));
      }
    });

    // Cold worker startup can be delayed by host scheduling/disk pressure. Give
    // startup its own bounded budget; encoding keeps the shorter deadline.
    timeout = setTimeout(() => settleWithError(new Error(he.audioConversionFailed)), 45_000);
    worker.once("online", () => {
      if (settled) return;
      clearTimeout(timeout);
      markPerformanceAudit("recording-audio:encoder-online");
      timeout = setTimeout(() => settleWithError(new Error(he.audioConversionFailed)), 15_000);
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    worker.postMessage(
      {
        pcmBuffer,
        sampleRate: payload.sampleRate
      },
      [pcmBuffer]
    );
  });
}
