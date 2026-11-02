/* @vitest-environment node */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallAudioClient } from "@main/services/calls/call-audio.client";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const PREFIXES = ["us.zoom."];
const STOPPED = { micOffsetMs: 0, systemOffsetMs: 0, systemHeard: true };
const flush = () => new Promise((resolve) => setImmediate(resolve));

let client: CallAudioClient;

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
    exitCode: null as number | null, signalCode: null as string | null
  });
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  return child;
}

function setup() {
  const child = fakeChild();
  const write = vi.spyOn(child.stdin, "write");
  const sent = () => write.mock.calls.map(([line]) => JSON.parse(String(line)) as { type: string; id?: number });
  client = new CallAudioClient("fixture");
  client.watch(PREFIXES);
  const reply = async (event: object) => {
    child.stdout.write(`${JSON.stringify(event)}\n`);
    await flush();
  };
  const exit = () => {
    child.signalCode = "SIGTERM";
    child.emit("close");
  };
  return { child, write, sent, reply, exit };
}

function settled<T>(promise: Promise<T>) {
  const state = { done: false };
  void promise.then(() => { state.done = true; });
  return state;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });

afterEach(() => {
  client.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CallAudioClient", () => {
  it("sends stop, then SIGTERM, when a start passes its deadline", async () => {
    const { child, write, sent } = setup();
    const started = client.start("/calls/a", PREFIXES);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await started).toBe(false);
    expect(sent().map((message) => message.type)).toEqual(["watch", "start", "stop"]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(write.mock.invocationCallOrder.at(-1)!).toBeLessThan(child.kill.mock.invocationCallOrder[0]!);
  });

  it("does not let a late reply to an abandoned start answer a newer one", async () => {
    const { sent, reply } = setup();
    const first = client.start("/calls/a", PREFIXES);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    const late = sent()[1]!.id;

    const second = client.start("/calls/b", PREFIXES);
    const state = settled(second);
    await reply({ type: "started", id: late });
    await reply({ type: "error", reason: "disk", id: late });
    await flush();
    expect(state.done).toBe(false);

    await reply({ type: "started", id: sent().at(-1)!.id });
    expect(await second).toBe(true);
  });

  it("leaves a helper that started in time alone", async () => {
    const { child, sent, reply } = setup();
    const started = client.start("/calls/a", PREFIXES);
    await reply({ type: "started", id: sent().at(-1)!.id });
    expect(await started).toBe(true);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("works again after the replacement helper takes over", async () => {
    const { exit } = setup();
    const first = client.start("/calls/a", PREFIXES);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    const next = fakeChild();
    const write = vi.spyOn(next.stdin, "write");
    exit();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);

    const started = client.start("/calls/b", PREFIXES);
    const { id } = JSON.parse(String(write.mock.calls.at(-1)![0])) as { id: number };
    next.stdout.write(`${JSON.stringify({ type: "started", id })}\n`);
    expect(await started).toBe(true);
  });

  it("ends a helper that does not answer a stop", async () => {
    const { child } = setup();
    const stopped = client.stop();
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(stopped).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("forces out a helper that ignores SIGTERM after a missed start", async () => {
    const { child } = setup();
    void client.start("/calls/a", PREFIXES);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("forces out a helper that ignores SIGTERM after a bad line", async () => {
    const { child } = setup();
    child.stdout.write("not json\n");
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("does not force out a helper that ended after SIGTERM", async () => {
    const { child, exit } = setup();
    void client.start("/calls/a", PREFIXES);
    await vi.advanceTimersByTimeAsync(10_000);
    exit();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("holds a stalled stop until the helper has ended", async () => {
    const { child, exit } = setup();
    const stopped = client.stop();
    const state = settled(stopped);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(state.done).toBe(false);

    exit();
    await expect(stopped).resolves.toBeNull();
  });

  it("keeps a stop report that arrives before the helper ends", async () => {
    const { sent, reply } = setup();
    const stopped = client.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await reply({ ...STOPPED, type: "stopped", id: sent().at(-1)!.id });
    await expect(stopped).resolves.toEqual(STOPPED);
  });

  it("gives up on a stalled stop once SIGKILL has been sent", async () => {
    const { child } = setup();
    const stopped = client.stop();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    await expect(stopped).resolves.toBeNull();
  });

  it("does not signal a helper that already ended during disposal", async () => {
    const { child, exit } = setup();
    const stopped = client.stop();
    client.dispose();
    exit();
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(stopped).resolves.toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("starts one replacement when the watch list arrives during the restart delay", async () => {
    const { exit } = setup();
    fakeChild();
    exit();
    client.watch(PREFIXES);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not let a late reply to a timed out stop answer a newer one", async () => {
    const { sent, reply } = setup();
    const first = client.stop();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await first).toBeNull();
    const late = sent().at(-1)!.id;

    const second = client.stop();
    const state = settled(second);
    await reply({ ...STOPPED, type: "stopped", id: late, micOffsetMs: 111 });
    await flush();
    expect(state.done).toBe(false);

    await reply({ ...STOPPED, type: "stopped", id: sent().at(-1)!.id, micOffsetMs: 222 });
    expect(await second).toEqual({ ...STOPPED, micOffsetMs: 222 });
  });

  it("ends a start the helper refused without waiting for the deadline, and leaves the helper up", async () => {
    const { child, sent, reply } = setup();
    const started = client.start("/calls/a", PREFIXES);
    await reply({ type: "error", reason: "input", id: sent().at(-1)!.id });
    expect(await started).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("drops a helper that answers without an id", async () => {
    const { child, reply } = setup();
    const started = client.start("/calls/a", PREFIXES);
    await reply({ type: "started" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await started).toBe(false);
  });

  it("leaves no capture running in a real process after the deadline", async () => {
    const work = mkdtempSync(join(tmpdir(), "meluli-call-helper-"));
    const log = join(work, "helper.log");
    const script = join(work, "helper.mjs");
    const executable = join(work, "helper");
    writeFileSync(log, "");
    // A wrapper, because a shebang cannot hold the spaces in an Electron path under the test runner.
    writeFileSync(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
    writeFileSync(script, `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const note = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
note("pid " + process.pid);
createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", (line) => {
  const message = JSON.parse(line);
  note("cmd " + message.type);
  if (message.type !== "start") return;
  // Files are open but Recording has not returned yet, as in a slow CoreAudio call.
  setTimeout(() => {
    console.log(JSON.stringify({ type: "started", id: message.id }));
    setInterval(() => note("capturing"), 20);
  }, 400);
});
`);
    chmodSync(executable, 0o755);
    const lines = () => readFileSync(log, "utf8");
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    client = new CallAudioClient(executable);
    client.watch(PREFIXES);
    await vi.waitFor(() => { expect(lines()).toContain("cmd watch"); }, { timeout: 10_000 });
    const started = client.start(work, PREFIXES);
    await vi.waitFor(() => { expect(lines()).toContain("cmd start"); });
    const pid = Number(/pid (\d+)/.exec(lines())![1]);
    expect(alive(pid)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(await started).toBe(false);
    await vi.waitFor(() => { expect(alive(pid)).toBe(false); });
    expect(lines()).not.toContain("capturing");
    rmSync(work, { recursive: true, force: true });
  });
});
