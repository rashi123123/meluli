// The host functions the Swift side installs under `__native` (native/host/*.swift).
type NativeBytes = Uint8Array;

interface NativeHost {
  log(level: string, message: string): void;
  setTimer(ms: number, repeats: boolean, callback: () => void): number;
  clearTimer(id: number): void;
  utf8Encode(text: string): NativeBytes;
  utf8Decode(bytes: Uint8Array | ArrayBuffer): string;
  base64Encode(bytes: Uint8Array): string;
  base64Decode(text: string): NativeBytes;
  hrtime(): number;
  now(): number;
  environment(): Record<string, string>;
  cwd(): string;
  pid: number;
  arguments: string[];
  systemVersion: string;
  kill(pid: number, signal: number): boolean;
  cpuUsage(): { user: number; system: number };
  exit(code: number): never;

  fsSync(op: string, args: unknown[], data?: Uint8Array | string | null): any;
  fsAsync(op: string, args: unknown[], data: Uint8Array | string | null, callback: (error: Error | null, result?: any) => void): void;

  spawn(path: string, args: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: string; stdout?: string; stderr?: string },
    onEvent: (event: string, ...args: any[]) => void): { id: number; pid: number };
  processWrite(id: number, data: Uint8Array): boolean;
  processEndInput(id: number): void;
  processKill(id: number, signal: number): boolean;

  fetch(request: { url: string; method: string; headers: [string, string][]; body: Uint8Array | null; redirect: string },
    onEvent: (event: string, ...args: any[]) => void): number;
  fetchCancel(id: number): void;
  fetchConsumed(id: number, bytes: number): void;

  sqliteOpen(path: string, readonly: boolean): number;
  sqliteClose(id: number): void;
  sqliteExec(id: number, sql: string): void;
  sqlitePrepare(id: number, sql: string): { id: number; reader: boolean; readonly: boolean };
  sqliteFinalize(id: number): void;
  sqliteStep(statement: number, params: unknown[], mode: "run" | "get" | "all" | "pluck"): any;
  sqliteInTransaction(id: number): boolean;

  hashCreate(algorithm: string): number;
  hashUpdate(id: number, data: Uint8Array | string): void;
  hashDigest(id: number): NativeBytes;
  randomUUID(): string;
  randomBytes(count: number): NativeBytes;

  parseUrl(input: string, base: string | null): Record<string, string> | null;

  // The app host only (native/host/Electron/UIBridge.swift, ElectronApp.swift, app/main.swift); the CLI host used by
  // conformance defines none of these, and only the electron/ modules call them.
  ui(op: string, args: unknown[]): unknown;
  uiPost(op: string, args: unknown[]): void;
  uiAsync(op: string, args: unknown[], callback: (result: any) => void): void;
  uiEvents(listener: (event: string, payload: unknown) => void): void;
  safeStorageAvailable(): boolean;
  safeStorageEncrypt(text: string): NativeBytes;
  safeStorageDecrypt(data: Uint8Array): string;
  resourcesPath?: string;
  isPackaged?: boolean;
  /** A build signed with the development profile (HostNames.isDevelopmentBuild). */
  isDevelopmentBuild?: boolean;
}

declare const __native: NativeHost;

/** The `process` object globals.ts installs (typed loosely; src/main is checked against @types/node). */
declare const process: {
  env: Record<string, string | undefined>;
  arch: string;
  platform: string;
  versions: Record<string, string>;
  cwd(): string;
  [name: string]: any;
};
