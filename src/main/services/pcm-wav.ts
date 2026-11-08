// The audio the whisper worker reads: mono PCM16 WAV with the plain 44-byte header, at 16 kHz.
// The call helper (native/CallAudio.swift) writes the same layout, and afconvert is asked for it.
// The WAV encoder that runs in a worker thread (recording-wav.ts) keeps its own copy, since a worker's
// source cannot import; it must stay byte for byte the same.

export const WORKER_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;

export function wavHeader(dataBytes: number, sampleRate = WORKER_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(dataBytes + WAV_HEADER_BYTES - 8, 4); header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36, "ascii"); header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Float samples to PCM16: clamped to [-1, 1], rounded, a missing or NaN sample as silence. */
export function pcm16(pcm: Float32Array): Buffer {
  const bytes = Buffer.alloc(pcm.length * 2);
  for (let index = 0; index < pcm.length; index += 1) {
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[index] || 0)) * 0x7fff), index * 2);
  }
  return bytes;
}
