import { ClipboardBridgeService, type ClipboardLease } from "./clipboard-bridge.service";
import { execFile } from "node:child_process";
import { systemPreferences } from "electron";
import { he } from "@shared/locale";
import { pipelineTrace } from "../pipeline-trace";
import { NativeInsertionFailure, type NativeInsertOptions, type NativeInsertionClient } from "./native-insertion-client";

const CLIPBOARD_RESTORE_DELAY_MS = 1000;
const TARGET_APP_DID_NOT_ACTIVATE_MESSAGE = "target app did not become active";

function runOsaScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);

  return new Promise((resolve, reject) => {
    const operation = lines.some(line => line.includes("key code 9")) ? "native_paste" : "target_capture";
    pipelineTrace(operation, "start");
    execFile("/usr/bin/osascript", args, { timeout: 4_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      pipelineTrace(operation, "end", { success: !error, code: error ? String(error.code ?? "unknown") : null,
        killed: error?.killed ?? false, signal: error?.signal ?? null,
        osError: stderr?.match(/\((-?\d+)\)\s*$/)?.[1] ?? null });
      if (error) {
        // execFile error.message includes the entire command, including our own
        // target-error sentinel. A timeout must not be misclassified as that error.
        reject(new Error(stderr?.trim() || he.textInsertionFailed));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface TargetApplication {
  name: string;
  pid: number;
  bundleId: string | null;
}

export type TextInsertionFailureCode = "permission" | "target_unavailable" | "target_changed" | "secure_field" | "clipboard_changed" | "paste_failed";

export class TextInsertionError extends Error {
  constructor(
    public readonly code: TextInsertionFailureCode,
    message: string
  ) {
    super(message);
    this.name = "TextInsertionError";
  }
}

const NATIVE_REFUSALS: Record<string, [TextInsertionFailureCode, string]> = {
  accessibility_permission: ["permission", he.accessibilityPermissionNeeded],
  event_permission: ["permission", he.accessibilityPermissionNeeded],
  secure_field: ["secure_field", he.textInsertionSecureField],
  target_not_active: ["target_changed", he.textInsertionTargetChanged],
  focus_moved: ["target_changed", he.textInsertionTargetChanged],
  field_unreadable: ["target_changed", he.textInsertionTargetChanged],
  selection_changed: ["target_changed", he.textInsertionTargetChanged],
  target_closed: ["target_unavailable", he.textInsertionTargetUnavailable],
  stale_target: ["target_unavailable", he.textInsertionTargetUnavailable],
  clipboard_changed: ["clipboard_changed", he.textInsertionClipboardChanged]
};

function normalizeInsertionError(error: unknown): TextInsertionError {
  if (error instanceof TextInsertionError) {
    return error;
  }
  const refusal = error instanceof NativeInsertionFailure ? NATIVE_REFUSALS[error.message] : undefined;
  if (refusal) return new TextInsertionError(...refusal);

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes(he.accessibilityPermissionNeeded)) {
    return new TextInsertionError("permission", he.accessibilityPermissionNeeded);
  }

  if (message.includes(TARGET_APP_DID_NOT_ACTIVATE_MESSAGE)) {
    return new TextInsertionError("target_unavailable", he.textInsertionTargetUnavailable);
  }

  return new TextInsertionError("paste_failed", he.textInsertionFailed);
}

export class TextInsertionService {
  private outcome: "confirmed" | "dispatched_unverified" | "not_dispatched" | "unresolved" | "command_completed_unverified" = "not_dispatched";
  getLastInsertionOutcome() { return this.outcome; }
  private targetApplication: TargetApplication | null = null;
  private inserting = false;
  private captureGeneration = 0;
  private capturing: Promise<void> | null = null;
  private ownWindowFrontmost = false;
  private nativeTargetToken: string | null = null;
  private nativeOutcomeUnknown = false;
  private clipboardHold: Promise<void> | null = null;
  private researchTargetSnapshot: Record<string, unknown> | null = null;
  private frontmostPid: number | null = null;
  onFrontmostChanged: (() => void) | null = null;
  /** Cmd-V may have reached the target without an observed effect, so pasting again could duplicate text. */
  hasUnknownNativeOutcome(): boolean { return this.nativeOutcomeUnknown; }
  getRecoveryTargetMetadata(): Record<string, unknown> | null {
    return this.targetApplication ? { ...this.targetApplication, ...(this.researchTargetSnapshot ?? {}) } : null;
  }

  constructor(
    private readonly clipboardBridge: ClipboardBridgeService,
    private readonly releaseOverlayFocus: () => () => void = () => () => {},
    private readonly researchNativePaste?: string,
    private readonly persistentNative?: Pick<NativeInsertionClient, "capture" | "insert"> & Partial<Pick<NativeInsertionClient, "cancelUnresolvedInsertion" | "usesClipboard" | "onFrontmostChanged">>,
    /** Production keeps the AppleScript path for a helper that cannot run. A helper refusal is final; research stays strict. */
    private readonly legacyFallback = false
  ) {
    if (this.persistentNative) this.persistentNative.onFrontmostChanged = (pid) => {
      this.frontmostPid = pid;
      this.onFrontmostChanged?.();
    };
  }

  /** The user is still looking at the place they dictate into, or the helper cannot tell. */
  getFrontmostPid(): number | null { return this.frontmostPid; }

  isAttentionOnTarget(): boolean {
    return this.frontmostPid === null || !this.targetApplication
      || this.frontmostPid === this.targetApplication.pid || this.frontmostPid === process.pid;
  }

  cancelPendingResearchInsertion(): void {
    if (this.inserting) this.persistentNative?.cancelUnresolvedInsertion?.();
  }

  /** Resolves once no capture is running, so a session can read the target that it started. */
  whenCaptureSettled(): Promise<void> {
    return this.capturing ?? Promise.resolve();
  }

  captureCurrentTargetApplication(shouldCapture: () => boolean = () => true): Promise<TargetApplication | null> {
    const capture = this.captureTarget(shouldCapture);
    const settled: Promise<void> = capture.then(() => undefined, () => undefined).finally(() => {
      if (this.capturing === settled) this.capturing = null;
    });
    this.capturing = settled;
    return capture;
  }

  private async captureTarget(shouldCapture: () => boolean): Promise<TargetApplication | null> {
    if (process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1") {
      this.targetApplication = { name: "Test editor", pid: 1, bundleId: null };
      return this.targetApplication;
    }
    if (process.platform !== "darwin") {
      return null;
    }

    const generation = ++this.captureGeneration;
    try {
      let nativeToken: string | null = null;
      let nativeSnapshot: Record<string, unknown> | null = null;
      const nativeFrontmost = this.persistentNative ? await this.persistentNative.capture().then(({ target, token }) => {
        nativeToken = token; nativeSnapshot = { ...target }; return [target.name, target.bundleId, target.pid].join("\n");
      }).catch((error: unknown) => {
        // The helper answered, so there is nothing for the fallback to add.
        if (this.legacyFallback && error instanceof NativeInsertionFailure && (error.message === "own_application" || error.message === "target_unavailable")) throw error;
        if (this.legacyFallback) return null;
        throw error;
      }) : null;
      const frontmost = nativeFrontmost ?? (this.researchNativePaste ? await new Promise<string>((resolve, reject) => {
        pipelineTrace("target_capture_native", "start");
        execFile(this.researchNativePaste!, ["--capture"], { timeout: 2_000, maxBuffer: 8192 }, (error, stdout) => {
          pipelineTrace("target_capture_native", "end", { success: !error });
          if (error) { reject(error); return; }
          try {
            const target = JSON.parse(stdout);
            resolve([target.name, target.bundleId, target.pid].join("\n"));
          } catch (failure) { reject(failure); }
        });
      }) : await runOsaScript([
        'tell application "System Events"',
        "set frontApp to first application process whose frontmost is true",
        "set frontName to name of frontApp",
        "set frontBundleId to bundle identifier of frontApp",
        'return frontName & linefeed & (frontBundleId as text) & linefeed & (unix id of frontApp as text)',
        "end tell"
      ]));

      if (generation !== this.captureGeneration || !shouldCapture()) return this.targetApplication;
      const [name, bundleId, pid] = frontmost.split(/\r?\n/, 3);
      if (Number(pid) === process.pid) {
        this.ownWindowFrontmost = !this.targetApplication;
        return this.targetApplication;
      }
      this.ownWindowFrontmost = false;
      this.frontmostPid = Number(pid);
      this.nativeTargetToken = nativeToken;
      this.researchTargetSnapshot = nativeSnapshot;
      this.targetApplication = name && Number.isSafeInteger(Number(pid)) && Number(pid) > 0
        ? {
            name,
            pid: Number(pid),
            bundleId: bundleId || null
          }
        : null;
    } catch (error) {
      if (generation === this.captureGeneration && shouldCapture()) {
        if (error instanceof NativeInsertionFailure && error.message === "own_application") {
          this.ownWindowFrontmost = !this.targetApplication;
          return this.targetApplication;
        }
        this.targetApplication = null;
      }
    }

    return this.targetApplication;
  }

  clearTargetApplication(): void {
    this.captureGeneration += 1;
    this.targetApplication = null;
    this.ownWindowFrontmost = false;
    this.nativeTargetToken = null;
    this.researchTargetSnapshot = null;
  }

  /** Dictating into Meluli itself: there is no other app to paste into, and nothing went wrong. */
  isOwnWindowTarget(): boolean {
    return this.ownWindowFrontmost && !this.targetApplication;
  }

  getCapturedTargetApplicationName(): string | null {
    return this.targetApplication?.name ?? null;
  }

  /** Pastes once. A refusal keeps the target, so `explicit` can offer the same transcript again. */
  async insertIntoCapturedTarget(text: string, operationId?: string, options: NativeInsertOptions = {}): Promise<boolean> {
    if (this.inserting) throw new TextInsertionError("paste_failed", he.textInsertionFailed);
    this.outcome = "not_dispatched";
    const targetApplication = this.targetApplication;

    if (!targetApplication) throw new TextInsertionError("target_unavailable", he.textInsertionTargetUnavailable);
    this.inserting = true;
    try {
      const inserted = await this.insertText(text, targetApplication, operationId, options);
      this.clearTargetApplication();
      return inserted;
    } finally {
      this.inserting = false;
    }
  }

  private async insertText(text: string, targetApplication: TargetApplication | null, operationId: string | undefined, options: NativeInsertOptions): Promise<boolean> {
    this.outcome = "not_dispatched";
    this.nativeOutcomeUnknown = false;
    if (!text.trim()) {
      return false;
    }

    if (process.platform !== "darwin") {
      throw new TextInsertionError("paste_failed", he.textInsertionUnsupported);
    }

    if (process.env.IVRIT_E2E_MOCK === "1" || process.env.IVRIT_USE_MOCK_SERVICES === "1") {
      return true; // Explicit isolated E2E mode never changes the real clipboard or frontmost app.
    }
    const hasAccessibility = systemPreferences.isTrustedAccessibilityClient(!this.persistentNative || this.legacyFallback);
    if (!hasAccessibility) {
      throw new TextInsertionError("permission", he.accessibilityPermissionNeeded);
    }

    let pasted = false;
    const restoreOverlay = this.releaseOverlayFocus();
    let lease: ClipboardLease | undefined;

    try {
      const nativeToken = this.nativeTargetToken;
      if (this.persistentNative && (!this.legacyFallback || (targetApplication && nativeToken))) {
        if (!targetApplication || !nativeToken) throw new TextInsertionError("target_unavailable", he.textInsertionTargetUnavailable);
        if (this.persistentNative.usesClipboard) {
          if (this.clipboardHold) await this.clipboardHold;
          lease = await this.clipboardBridge.begin(text);
        }
        pipelineTrace("persistent_ax_insertion", "start");
        try {
          this.outcome = "unresolved";
          const delivered = await this.persistentNative.insert(nativeToken, text, operationId, options);
          pasted = true;
          this.outcome = delivered === "unverified" ? "dispatched_unverified" : "confirmed";
          return true;
        } catch (error) {
          // A refusal means this destination is not safe right now. Trying the blind path
          // anyway is exactly the paste into an uncertain place that it just prevented.
          this.nativeOutcomeUnknown = !(error instanceof NativeInsertionFailure && error.state === "not_dispatched");
          throw error;
        }
        finally { pipelineTrace("persistent_ax_insertion", "end", { confirmed: pasted }); }
      }
      if (!lease) {
        if (this.clipboardHold) await this.clipboardHold;
        lease = await this.clipboardBridge.begin(text);
      }
      const targetBundleId = targetApplication?.bundleId
        ? escapeAppleScriptString(targetApplication.bundleId)
        : null;
      const targetPid = targetApplication?.pid;
      const targetMatcher = targetPid
        ? `unix id of frontApp is ${targetPid}${targetBundleId ? ` and bundle identifier of frontApp is "${targetBundleId}"` : ""}`
        : null;
      // Activate the already captured process. Never relaunch a stale target or
      // choose another process merely because it has the same application name.
      // Only a person asking again may pull focus back; otherwise the target must already be in front.
      const activateTarget = targetPid
        ? `tell application "System Events" to set frontmost of first application process whose unix id is ${targetPid} to true`
        : null;

      // Physical ANSI V is independent of the active Hebrew/Latin input source.
      // Character-based keystroke "v" can succeed without triggering Paste.
      const scriptLines = targetMatcher && activateTarget
        ? [
            ...(options.explicit ? [activateTarget] : []),
            'tell application "System Events"',
            // Activation is asynchronous, especially while the OS is busy. The
            // overall script timeout still bounds this wait and prevents a late
            // paste from being sent after the target activation has failed.
            "repeat 20 times",
            "set frontApp to first application process whose frontmost is true",
            `if (${targetMatcher}) then exit repeat`,
            "delay 0.05",
            "end repeat",
            "set frontApp to first application process whose frontmost is true",
            `if not (${targetMatcher}) then error "${TARGET_APP_DID_NOT_ACTIVATE_MESSAGE}"`,
            'key code 9 using command down',
            "end tell"
          ]
        : ['tell application "System Events" to key code 9 using command down'];

      if (this.researchNativePaste && targetApplication?.bundleId) {
        pipelineTrace("native_paste_acknowledged", "start");
        await new Promise<void>((resolve, reject) => {
          const child = execFile(this.researchNativePaste!, [], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
            let state = "unknown", reason = "helper_failed";
            try { ({ state, reason } = JSON.parse(stdout.trim())); } catch { /* uncertain; never retry */ }
            this.outcome = state === "confirmed" ? "confirmed" : state === "not_dispatched" ? "not_dispatched" : "unresolved";
            pipelineTrace("native_paste_acknowledged", "end", { state, reason, killed: error?.killed ?? false });
            if (!error && state === "confirmed") resolve();
            else reject(new TextInsertionError("paste_failed", `Native insertion ${state}: ${reason}. Inspect target before copying from history.`));
          });
          child.stdin?.on("error", () => { /* execFile completion owns the uncertain outcome. */ });
          child.stdin?.end(JSON.stringify({ pid: targetApplication.pid, bundleId: targetApplication.bundleId, text }) + "\n");
        });
      } else {
        this.outcome = "unresolved";
        await runOsaScript(scriptLines);
        this.outcome = "command_completed_unverified";
      }
      pasted = true;
      return true;
    } catch (error) {
      const notDispatched = error instanceof NativeInsertionFailure ? error.state === "not_dispatched"
        : error instanceof Error && error.message.includes(TARGET_APP_DID_NOT_ACTIVATE_MESSAGE);
      if (notDispatched) this.outcome = "not_dispatched";
      // Only a failure proven to precede Cmd-V may be retried: a timed-out osascript may have sent it.
      else if (this.outcome === "unresolved") this.nativeOutcomeUnknown = true;
      throw normalizeInsertionError(error);
    } finally {
      pipelineTrace("clipboard_hold", "start", { pasted });
      if (pasted && this.outcome !== "confirmed") await new Promise(resolve => setTimeout(resolve, CLIPBOARD_RESTORE_DELAY_MS));
      pipelineTrace("clipboard_hold", "end");
      try {
        // The payload stays available to a late Cmd-V. The next insertion waits for
        // this hold instead of the overlay, which must report the outcome now.
        if (lease?.quarantine && this.nativeOutcomeUnknown)
          this.clipboardHold = lease.quarantine().catch(() => undefined).finally(() => { this.clipboardHold = null; });
        else await lease?.restore();
      } finally { restoreOverlay(); }
    }
  }
}
