import { globalShortcut } from "electron";
import { he } from "@shared/locale";

interface ShortcutBindings {
  recording: string;
  overlay: string;
}

export class ShortcutManager {
  private registeredShortcuts = new Set<string>();
  private escapeClaimed = false;
  private undoClaimed = false;
  private bindings: ShortcutBindings = {
    recording: "",
    overlay: ""
  };

  constructor(
    private readonly handlers: {
      onRecordingToggle: () => void;
      onOverlayOpen: () => void;
      onEscape?: () => void;
      onUndo?: () => void;
    }
  ) {}

  /** Esc belongs to the frontmost app except during a dictation, when it means cancel. */
  setEscapeActive(active: boolean): void {
    if (active === this.escapeClaimed || (process.env.IVRIT_E2E_MOCK === "1" && process.env.MELULI_USER_DATA)) return;
    if (active) this.escapeClaimed = globalShortcut.register("Escape", () => this.handlers.onEscape?.());
    else {
      globalShortcut.unregister("Escape");
      this.escapeClaimed = false;
    }
  }

  /** Cmd-Z belongs to the frontmost app except for the moments a canceled dictation can be restored. */
  setUndoActive(active: boolean): void {
    if (active === this.undoClaimed || (process.env.IVRIT_E2E_MOCK === "1" && process.env.MELULI_USER_DATA)) return;
    if (active) this.undoClaimed = globalShortcut.register("CommandOrControl+Z", () => this.handlers.onUndo?.());
    else {
      globalShortcut.unregister("CommandOrControl+Z");
      this.undoClaimed = false;
    }
  }

  registerAll(nextBindings: ShortcutBindings): ShortcutBindings {
    if (nextBindings.recording === nextBindings.overlay) {
      throw new Error(he.shortcutConflict);
    }

    const previousBindings = this.getBindings();
    this.unregister();
    // Protocol/UI tests must not claim the user's global keyboard shortcuts.
    if (process.env.IVRIT_E2E_MOCK === "1" && process.env.MELULI_USER_DATA) {
      this.bindings = { ...nextBindings };
      return this.getBindings();
    }

    try {
      this.claim(nextBindings);
    } catch (error) {
      // A rejected change must leave the working shortcuts in place.
      this.unregister();
      if (previousBindings.recording && previousBindings.overlay) this.claim(previousBindings);
      throw error;
    }

    this.bindings = { ...nextBindings };
    return this.getBindings();
  }

  private claim(bindings: ShortcutBindings): void {
    this.claimOne(bindings.recording, this.handlers.onRecordingToggle);
    this.claimOne(bindings.overlay, this.handlers.onOverlayOpen);
  }

  private claimOne(shortcut: string, handler: () => void): void {
    let registered = false;
    try {
      registered = globalShortcut.register(shortcut, handler);
    } catch {
      // Electron throws, rather than returning false, on an accelerator it cannot parse.
    }
    if (!registered) {
      throw new Error(he.shortcutRegisterFailed);
    }

    this.registeredShortcuts.add(shortcut);
  }

  setRecordingShortcut(shortcut: string): string {
    return this.registerAll({
      ...this.bindings,
      recording: shortcut
    }).recording;
  }

  setOverlayShortcut(shortcut: string): string {
    return this.registerAll({
      ...this.bindings,
      overlay: shortcut
    }).overlay;
  }

  getBindings(): ShortcutBindings {
    return { ...this.bindings };
  }

  unregister(): void {
    for (const shortcut of this.registeredShortcuts) {
      globalShortcut.unregister(shortcut);
    }
    this.registeredShortcuts.clear();
  }

  dispose(): void {
    this.unregister();
    this.bindings = {
      recording: "",
      overlay: ""
    };
    globalShortcut.unregisterAll();
  }
}
