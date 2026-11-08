import type { UpdateStatus } from "@shared/types";
import { RejectedFeedError } from "./update-feed";

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The part of Electron's autoUpdater this service uses. */
export interface UpdateDriver {
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  /** The native host stages the downloaded update for after quitting, throwing if it cannot. */
  prepareInstall?(): void;
  on(event: "update-available" | "update-not-available", listener: () => void): unknown;
  on(event: "update-downloaded", listener: (event: unknown, notes: string, name: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Fetches new versions quietly. Installing waits for the person or for the next launch. */
export class UpdateService {
  private status: UpdateStatus = "off";
  private version: string | null = null;
  private listening = false;
  private checking = false;
  private firstCheck: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly driver: UpdateDriver,
    private readonly feedUrl: string,
    private readonly isEnabled: () => boolean,
    private readonly onStatus: (status: UpdateStatus, version: string | null) => void,
    /** Reads the feed first, so Squirrel only starts on a release this version may move to. */
    private readonly findUpdate: () => Promise<string | null>
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
    this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.firstCheck.unref();
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
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

  private async check(): Promise<void> {
    if (this.checking || this.status === "downloading" || this.status === "ready") return;
    this.checking = true;
    let update: string | null;
    try {
      update = await this.findUpdate();
    } catch (error) {
      console.warn("[UpdateService] update feed unavailable", error);
      // Being offline is normal. A feed that fails verification is not.
      if (error instanceof RejectedFeedError) this.setStatus("failed");
      return;
    } finally {
      this.checking = false;
    }
    // Checking was turned off while the feed was on its way.
    if (!this.interval) return;
    if (!update) {
      this.setStatus("idle");
      return;
    }
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

  /** Whether quitting now will install an update. Run it before the app tears anything down: an
   * update that cannot be staged shows as failed and the app keeps running. */
  prepareInstall(): boolean {
    if (this.status !== "ready") return false;
    if (!this.driver.prepareInstall) return true;
    try {
      this.driver.prepareInstall();
      return true;
    } catch (error) {
      console.warn("[UpdateService] update install failed", error);
      this.setStatus("failed", null);
      return false;
    }
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
