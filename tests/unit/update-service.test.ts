import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RejectedFeedError } from "@main/services/update-feed";
import { UpdateService, type UpdateDriver } from "@main/services/update.service";
import type { UpdateStatus } from "@shared/types";

class FakeDriver extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function setup(feed = "https://example.test/releases.json", enabled = true, findUpdate = vi.fn(async (): Promise<string | null> => "1.2.3")) {
  const driver = new FakeDriver();
  const statuses: UpdateStatus[] = [];
  const state = { enabled };
  const service = new UpdateService(driver as unknown as UpdateDriver, feed, () => state.enabled, (status) => statuses.push(status), findUpdate);
  return { driver, statuses, service, state, findUpdate };
}

describe("UpdateService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays off without a feed or with the setting off", async () => {
    for (const { service, driver } of [setup(""), setup(undefined, false)]) {
      service.sync();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(driver.setFeedURL).not.toHaveBeenCalled();
      expect(driver.checkForUpdates).not.toHaveBeenCalled();
      service.dispose();
    }
  });

  it("checks after launch and on an interval, and registers listeners once", async () => {
    const { service, driver } = setup();
    service.sync();
    service.sync();
    expect(driver.listenerCount("update-downloaded")).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("stops checking once an update is ready and installs only on request", () => {
    const { service, driver, statuses } = setup();
    service.install();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    service.sync();
    driver.emit("update-available");
    driver.emit("update-downloaded", {}, "", "1.2.3");
    expect(statuses.at(-1)).toBe("ready");
    vi.advanceTimersByTime(7 * 60 * 60 * 1000);
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    service.install();
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("keeps a downloaded update when the setting is turned off", () => {
    const { service, driver, state, statuses } = setup();
    service.sync();
    driver.emit("update-downloaded", {}, "", "1.2.3");
    state.enabled = false;
    service.sync();
    expect(statuses.at(-1)).toBe("ready");
  });

  it("leaves Squirrel alone when the feed offers nothing newer", async () => {
    const { service, driver, statuses } = setup(undefined, true, vi.fn(async () => null));
    service.sync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("idle");
    service.dispose();
  });

  it("reports a feed that fails verification, but not a machine that is offline", async () => {
    const rejected = setup(undefined, true, vi.fn(async () => { throw new RejectedFeedError("bad"); }));
    rejected.service.sync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rejected.driver.checkForUpdates).not.toHaveBeenCalled();
    expect(rejected.statuses.at(-1)).toBe("failed");
    rejected.service.dispose();

    const offline = setup(undefined, true, vi.fn(async () => { throw new TypeError("fetch failed"); }));
    offline.service.sync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(offline.driver.checkForUpdates).not.toHaveBeenCalled();
    expect(offline.statuses.at(-1)).toBe("idle");
    offline.service.dispose();
  });

  it("does not start Squirrel when checking was turned off during the feed read", async () => {
    let answer!: (version: string) => void;
    const { service, driver } = setup(undefined, true, vi.fn(() => new Promise<string>((resolve) => { answer = resolve; })));
    service.sync();
    await vi.advanceTimersByTimeAsync(30_000);
    service.dispose();
    answer("1.2.3");
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports failures and goes off when the feed is refused", () => {
    const { service, driver, statuses } = setup();
    service.sync();
    driver.emit("error", new Error("signature"));
    expect(statuses.at(-1)).toBe("failed");
    service.dispose();

    const refused = setup();
    refused.driver.setFeedURL.mockImplementation(() => { throw new Error("not signed"); });
    refused.service.sync();
    expect(refused.statuses).toEqual([]);
    expect(refused.driver.listenerCount("error")).toBe(0);
  });

  it("stages an update before the app quits, and keeps the app running when it cannot", () => {
    const { service, driver, statuses } = setup();
    expect(service.prepareInstall()).toBe(false);
    service.sync();
    driver.emit("update-downloaded", {}, "", "1.2.3");
    // Electron's own updater has no staging step: being ready is enough.
    expect(service.prepareInstall()).toBe(true);

    const staging = Object.assign(driver, { prepareInstall: vi.fn() });
    expect(service.prepareInstall()).toBe(true);
    expect(staging.prepareInstall).toHaveBeenCalledTimes(1);

    staging.prepareInstall.mockImplementation(() => { throw new Error("cannot replace the app"); });
    expect(service.prepareInstall()).toBe(false);
    expect(statuses.at(-1)).toBe("failed");
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    service.dispose();
  });
});
