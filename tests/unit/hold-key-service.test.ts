/* @vitest-environment node */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoldKeyService } from "@main/services/hold-key.service";
import type { HoldKeyChoice, HoldKeyStatus } from "@shared/types";

const roots: string[] = [];
/** A real child process, so the pipes, exit codes and restarts are the real ones. */
function helper(check: string, body: string) {
  const root = mkdtempSync(join(tmpdir(), "hold-key-"));
  roots.push(root);
  const path = join(root, "helper");
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--check" ] || [ "$1" = "--request" ]; then echo ${check}; exit 0; fi\nread line\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function service(executable: string, key: HoldKeyChoice = "right_option") {
  const statuses: HoldKeyStatus[] = [];
  const events: string[] = [];
  let choice = key;
  const hold = new HoldKeyService(executable, () => choice, status => statuses.push(status));
  hold.onDown = () => events.push("down");
  hold.onUp = () => events.push("up");
  return { hold, statuses, events, choose: (next: HoldKeyChoice) => { choice = next; } };
}
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 3000, interval: 10 });

describe.runIf(process.platform === "darwin")("hold key helper", () => {
  const live: HoldKeyService[] = [];
  afterEach(() => {
    live.splice(0).forEach(hold => hold.dispose());
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  });
  const start = (executable: string, key?: HoldKeyChoice) => { const f = service(executable, key); live.push(f.hold); return f; };

  it("starts no process and stays off when no key is chosen", async () => {
    const f = start("/nonexistent/helper", "off");
    await f.hold.sync();
    expect(f.hold.getStatus()).toBe("off");
  });

  it("waits for permission without starting the watcher", async () => {
    const f = start(helper("denied", 'echo \'{"type":"ready"}\'; cat'));
    await f.hold.sync();
    expect(f.statuses).toEqual(["needs_permission"]);
  });

  it("reports press and release from the helper", async () => {
    const f = start(helper("granted", 'echo \'{"type":"ready"}\'; echo \'{"type":"down"}\'; echo \'{"type":"up"}\'; cat'));
    await f.hold.sync();
    await until(() => f.events.length >= 2);
    expect(f.statuses).toEqual(["ready"]);
    expect(f.events).toEqual(["down", "up"]);
  });

  it("ends a hold when the helper dies, since nothing else can see the key", async () => {
    const f = start(helper("granted", 'echo \'{"type":"ready"}\'; echo \'{"type":"down"}\'; exit 1'));
    await f.hold.sync();
    await until(() => f.events.includes("up"));
    expect(f.events.slice(0, 2)).toEqual(["down", "up"]);
  });

  it("goes back to asking when permission is withdrawn, without a restart loop", async () => {
    const f = start(helper("granted", 'echo \'{"type":"ready"}\'; echo \'{"reason":"permission","type":"error"}\'; exit 3'));
    await f.hold.sync();
    await until(() => f.hold.getStatus() === "needs_permission");
  });

  it.each(["tap", "input"])("restarts after a %s failure instead of asking for a permission already given", async reason => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true, advanceTimeDelta: 200 });
    try {
      const f = start(helper("granted", `echo '{"reason":"${reason}","type":"error"}'; exit 3`));
      await f.hold.sync();
      await vi.waitFor(() => expect(f.hold.getStatus()).toBe("unavailable"), { timeout: 15_000, interval: 50 });
      expect(f.statuses).not.toContain("needs_permission");
    } finally { vi.useRealTimers(); }
  }, 20_000);

  it("does not trust output outside the closed list", async () => {
    const f = start(helper("granted", 'echo \'{"type":"keydown","key":"a"}\'; cat'));
    await f.hold.sync();
    await until(() => f.events.includes("up"));
    expect(f.events).not.toContain("down");
  });

  it("gives up after repeated crashes and keeps the shortcut as the way in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true, advanceTimeDelta: 200 });
    try {
      const f = start(helper("granted", "exit 1"));
      await f.hold.sync();
      await vi.waitFor(() => expect(f.hold.getStatus()).toBe("unavailable"), { timeout: 15_000, interval: 50 });
    } finally { vi.useRealTimers(); }
  }, 20_000);

  it("stops watching when the key is turned off", async () => {
    const f = start(helper("granted", 'echo \'{"type":"ready"}\'; cat'));
    await f.hold.sync();
    await until(() => f.hold.getStatus() === "ready");
    f.choose("off");
    await f.hold.sync();
    expect(f.hold.getStatus()).toBe("off");
  });

  it("rechecks on return only while it is waiting for permission", async () => {
    const f = start(helper("granted", 'echo \'{"type":"ready"}\'; cat'));
    f.hold.recheck();
    expect(f.statuses).toEqual([]);
  });
});
