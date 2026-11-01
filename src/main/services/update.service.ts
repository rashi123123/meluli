import type { UpdateStatus } from "@shared/types";

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The part of Electron's autoUpdater this service uses. */
export interface UpdateDriver {
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: "update-available" | "update-not-available", listener: () => void): unknown;
  on(event: "update-downloaded", listener: (event: unknown, notes: string, name: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Fetches new versions quietly. Installing waits for the person or for the next launch. */
export class UpdateService {
  private status: UpdateStatus = "off";
  private version: string | null = null;
  private listening = false;
  private firstCheck: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly driver: UpdateDriver,
    private readonly feedUrl: string,
    private readonly isEnabled: () => boolean,
    private readonly onStatus: (status: UpdateStatus, version: string | null) => void
  ) {}

  private setStatus(status: UpdateStatus, version: string | null = this.version): void {
    if (this.status === status && this.version === version) return;
    this.status = status;
    this.version = version;
    this.onStatus(status, version);
  }

  /** Brings checking in line with the setting. Safe to call at any time. */
  sync(): void {
    this.stopChecking();
    // A downloaded update stays installable even if the person turns checking off afterwards.
    if (this.status === "ready") return;
    if (!this.feedUrl || !this.isEnabled()) {
      this.setStatus("off");
      return;
    }
    if (!this.attach()) return;

    this.setStatus("idle");
    this.firstCheck = setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
    this.firstCheck.unref();
    this.interval = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.interval.unref();
  }

  private attach(): boolean {
    if (this.listening) return true;
    try {
      this.driver.setFeedURL({ url: this.feedUrl, serverType: "json" });
    } catch (error) {
      // Electron refuses a feed in an app it cannot verify, such as one run from a dev build.
      console.warn("[UpdateService] updates unavailable", error);
      this.setStatus("off");
      return false;
    }
    this.driver.on("update-available", () => this.setStatus("downloading"));
    this.driver.on("update-not-available", () => this.setStatus("idle"));
    this.driver.on("update-downloaded", (_event, _notes, name) => {
      this.stopChecking();
      this.setStatus("ready", name || null);
    });
    this.driver.on("error", (error) => {
      console.warn("[UpdateService] update failed", error);
      if (this.status !== "ready") this.setStatus("failed");
    });
    this.listening = true;
    return true;
  }

  private check(): void {
    if (this.status === "downloading" || this.status === "ready") return;
    try {
      this.driver.checkForUpdates();
    } catch (error) {
      console.warn("[UpdateService] update check failed", error);
      this.setStatus("failed");
    }
  }

  install(): void {
    if (this.status === "ready") this.driver.quitAndInstall();
  }

  private stopChecking(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck);
    if (this.interval) clearInterval(this.interval);
    this.firstCheck = null;
    this.interval = null;
  }

  dispose(): void {
    this.stopChecking();
  }
}
