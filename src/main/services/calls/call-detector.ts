export const SUGGEST_AFTER_MS = 3_000;
export const CALL_END_AFTER_MS = 30_000;

export interface AppActivity {
  id: string;
  input: boolean;
  output: boolean;
}

interface Tracked {
  inputSince: number | null;
  lastInput: number;
  lastAudio: number;
  dismissed: boolean;
}

/** Decides from audio activity alone, so it never needs to see what an app is doing. */
export class CallDetector {
  private apps = new Map<string, Tracked>();

  update(activity: AppActivity[], now: number): void {
    const active = new Map(activity.map((app) => [app.id, app]));
    for (const [id, app] of active) {
      if (!app.input && !app.output) continue;
      const tracked = this.apps.get(id) ?? { inputSince: null, lastInput: 0, lastAudio: now, dismissed: false };
      tracked.lastAudio = now;
      if (app.input) {
        tracked.inputSince ??= now;
        tracked.lastInput = now;
      }
      this.apps.set(id, tracked);
    }
    for (const [id, tracked] of this.apps) {
      if (!active.get(id)?.input) tracked.inputSince = null;
    }
    this.forgetEnded(now);
  }

  /** The output of a browser can run all day, so a dismissal lasts only as long as the microphone stays in use. */
  private forgetEnded(now: number): void {
    for (const [id, tracked] of this.apps) {
      if (tracked.inputSince !== null) continue;
      if (now - tracked.lastInput >= CALL_END_AFTER_MS) tracked.dismissed = false;
      if (!tracked.dismissed && now - tracked.lastAudio >= CALL_END_AFTER_MS) this.apps.delete(id);
    }
  }

  /** A short microphone test should not raise a card, so input has to last. */
  suggestion(now: number): string | null {
    for (const [id, tracked] of this.apps) {
      if (tracked.inputSince !== null && !tracked.dismissed && now - tracked.inputSince >= SUGGEST_AFTER_MS) return id;
    }
    return null;
  }

  dismiss(id: string, now: number): void {
    const tracked = this.apps.get(id) ?? { inputSince: null, lastInput: now, lastAudio: now, dismissed: false };
    tracked.dismissed = true;
    this.apps.set(id, tracked);
  }

  /** An app that closes both directions has left the call. Muting keeps them open. */
  hasEnded(id: string, now: number): boolean {
    const tracked = this.apps.get(id);
    if (!tracked) return true;
    return tracked.inputSince === null && now - tracked.lastAudio >= CALL_END_AFTER_MS;
  }
}
