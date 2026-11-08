import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SafeStorage } from "electron";
import * as z from "zod";

const storedKeysSchema = z.record(z.string(), z.object({ host: z.string(), value: z.string() }));
const apiKeySchema = z.string().trim().min(1).max(1000).regex(/^[\x21-\x7e]+$/);

function parseFlowApiKey(value: unknown): string {
  return apiKeySchema.parse(value);
}

/**
 * Keys are encrypted by the macOS Keychain, one per connection, and each is bound to the
 * host it was entered for, so editing a connection's address can never send it elsewhere.
 */
export class FlowKeyStore {
  constructor(
    private readonly filePath: string,
    private readonly encryption: Pick<SafeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">
  ) {}

  private read(): z.infer<typeof storedKeysSchema> {
    try {
      return storedKeysSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch { return {}; }
  }

  private write(keys: z.infer<typeof storedKeysSchema>): void {
    if (Object.keys(keys).length === 0) { rmSync(this.filePath, { force: true }); return; }
    writeFileSync(this.filePath, JSON.stringify(keys), { mode: 0o600 });
  }

  isAvailable(): boolean { return this.encryption.isEncryptionAvailable(); }

  hasKey(connectionId: string, host: string): boolean { return this.read()[connectionId]?.host === host; }

  getKey(connectionId: string, host: string): string | null {
    const stored = this.read()[connectionId];
    if (stored?.host !== host || !this.isAvailable()) return null;
    try {
      return this.encryption.decryptString(Buffer.from(stored.value, "base64"));
    } catch { return null; }
  }

  set(connectionId: string, host: string, apiKey: string): void {
    if (!this.isAvailable()) throw new Error("Secure key storage is unavailable.");
    const value = this.encryption.encryptString(parseFlowApiKey(apiKey)).toString("base64");
    this.write({ ...this.read(), [connectionId]: { host, value } });
  }

  clear(connectionId: string): void {
    const { [connectionId]: _removed, ...rest } = this.read();
    this.write(rest);
  }

  /** Drops keys whose connection no longer exists. */
  retain(connectionIds: readonly string[]): void {
    const keep = new Set(connectionIds);
    const keys = this.read();
    const next = Object.fromEntries(Object.entries(keys).filter(([id]) => keep.has(id)));
    if (Object.keys(next).length !== Object.keys(keys).length) this.write(next);
  }
}
