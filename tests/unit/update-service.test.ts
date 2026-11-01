import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateService, type UpdateDriver } from "@main/services/update.service";
import type { UpdateStatus } from "@shared/types";

class FakeDriver extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function setup(feed = "https://example.test/releases.json", enabled = true) {
  const driver = new FakeDriver();
  const statuses: UpdateStatus[] = [];
  const state = { enabled };
  const service = new UpdateService(driver as unknown as UpdateDriver, feed, () => state.enabled, (status) => statuses.push(status));
  return { driver, statuses, service, state };
}

describe("UpdateService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays off without a feed or with the setting off", () => {
    for (const { service, driver } of [setup(""), setup(undefined, false)]) {
      service.sync();
      vi.advanceTimersByTime(60_000);
      expect(driver.setFeedURL).not.toHaveBeenCalled();
      expect(driver.checkForUpdates).not.toHaveBeenCalled();
      service.dispose();
    }
  });

  it("checks after launch and on an interval, and registers listeners once", () => {
    const { service, driver } = setup();
    service.sync();
    service.sync();
    expect(driver.listenerCount("update-downloaded")).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
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
});
