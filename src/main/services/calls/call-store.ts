import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CALL_APPS } from "@shared/call-apps";

const segmentSchema = z.object({ start: z.number(), end: z.number(), text: z.string() });
const trackProgressSchema = z.object({ done: z.number().int().nonnegative(), segments: z.array(segmentSchema) });

const callRecordSchema = z.object({
  id: z.uuid(),
  appId: z.enum(CALL_APPS.map((app) => app.id) as [string, ...string[]]),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  /** A file still marked recording with no live owner was left by a crash. Its audio is usable up to the crash. */
  status: z.enum(["recording", "pending", "failed"]),
  /** The process recording this call. A record without one predates the field. */
  ownerPid: z.number().int().positive().optional(),
  micOffsetMs: z.number().nonnegative(),
  systemOffsetMs: z.number().nonnegative(),
  systemHeard: z.boolean(),
  partial: z.boolean(),
  mic: trackProgressSchema,
  system: trackProgressSchema
});

export type CallRecord = z.infer<typeof callRecordSchema>;
export type CallTrack = "mic" | "system";

export function createCallRecord(id: string, appId: string, startedAt: number, ownerPid: number): CallRecord {
  const empty = () => ({ done: 0, segments: [] });
  return {
    id, appId, startedAt, endedAt: null, status: "recording", ownerPid, micOffsetMs: 0, systemOffsetMs: 0,
    systemHeard: true, partial: false, mic: empty(), system: empty()
  };
}

/** One folder per call under the profile. It holds audio and partial text until the call is transcribed. */
export class CallStore {
  constructor(private readonly root: string) {}

  directory(id: string): string {
    return join(this.root, id);
  }

  trackPath(id: string, track: CallTrack): string {
    return join(this.directory(id), `${track}.wav`);
  }

  piecePath(id: string): string {
    return join(this.directory(id), "piece.wav");
  }

  async create(record: CallRecord): Promise<void> {
    await mkdir(this.directory(record.id), { recursive: true, mode: 0o700 });
    await this.save(record);
  }

  async save(record: CallRecord): Promise<void> {
    const path = join(this.directory(record.id), "call.json");
    await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  async list(): Promise<CallRecord[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const records = await Promise.all(names.map(async (name) => {
      try {
        const parsed = callRecordSchema.safeParse(JSON.parse(await readFile(join(this.root, name, "call.json"), "utf8")));
        return parsed.success && parsed.data.id === name ? parsed.data : null;
      } catch {
        return null;
      }
    }));
    return records.filter((record) => record !== null).sort((a, b) => a.startedAt - b.startedAt);
  }

  async remove(id: string): Promise<void> {
    await rm(this.directory(id), { recursive: true, force: true });
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
