/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { NativeInsertionClient } from "@main/services/insertion/native-insertion-client";
import { TextInsertionService } from "@main/services/insertion/text-insertion.service";
import type { ClipboardBridgeService } from "@main/services/insertion/clipboard-bridge.service";
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("electron", () => ({ systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) } }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function setup(adaptive = false) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), exitCode: null as number | null });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const requests: Array<Record<string, string>> = [];
  child.stdin.on("data", bytes => requests.push(JSON.parse(bytes.toString())));
  const client = new NativeInsertionClient("fixture", 100, 4000, "native_paste", adaptive);
  const reply = (state: string, extra = {}) => child.stdout.write(JSON.stringify({ requestId: requests.at(-1)?.requestId, state, reason: "fixture", ...extra })+"\n");
  const ready = () => child.stdout.write('{"type":"ready","protocol":1}\n');
  return { client, child, requests, ready, reply };
}
it("reuses one helper, correlates responses and inserts once", async () => {
  const s=setup(), captured=s.client.capture();s.ready();await Promise.resolve();
  s.reply("captured", { targetToken:"token",target:{name:"Editor",pid:123,bundleId:"local.editor"} });expect((await captured).token).toBe("token");
  const inserted=s.client.insert("token","שלום dashboard");await Promise.resolve();s.reply("confirmed");await inserted;
  expect(spawn).toHaveBeenCalledOnce();expect(s.requests.map(x=>x.type)).toEqual(["capture","insert"]);
  s.child.exitCode=0;await s.client.dispose();
});
it("quarantines an ambiguous mutation and never sends a retry or restart", async () => {
  const s=setup(), call=s.client.capture();s.ready();await Promise.resolve();s.reply("captured",{targetToken:"t",target:{name:"E",pid:12,bundleId:"b"}});await call;
  const insert=s.client.insert("t","hello");const rejected=expect(insert).rejects.toMatchObject({state:"unresolved"});await Promise.resolve();s.reply("unresolved");await rejected;
  await expect(s.client.insert("t","hello")).rejects.toThrow();expect(s.requests).toHaveLength(2);expect(spawn).toHaveBeenCalledOnce();s.child.exitCode=0;await s.client.dispose();
});
it("times out, quarantines and kills a stalled helper without redispatch", async () => {
  vi.useFakeTimers();const s=setup(), call=s.client.capture();s.ready();await Promise.resolve();const rejected=expect(call).rejects.toMatchObject({state:"not_dispatched"});
  await vi.advanceTimersByTimeAsync(101);await rejected;await expect(s.client.capture()).rejects.toThrow();expect(s.requests).toHaveLength(1);expect(s.child.kill).toHaveBeenCalledWith("SIGTERM");s.child.exitCode=0;await s.client.dispose();
});
it('blocks concurrent and later duplicate transcript IDs before writing another request',async()=>{
 const s=setup(),cap=s.client.capture();s.ready();await Promise.resolve();s.reply('captured',{targetToken:'t',target:{name:'Editor',pid:2,bundleId:'local.editor'}});await cap;
 const first=s.client.insert('t','hello','same-id');await Promise.resolve();
 await expect(s.client.insert('t','hello','same-id')).rejects.toMatchObject({state:'duplicate_blocked'});
 s.reply('confirmed');await first;
 await expect(s.client.insert('new-token','hello','same-id')).rejects.toMatchObject({state:'duplicate_blocked'});
 expect(s.requests).toHaveLength(2);s.child.exitCode=0;await s.client.dispose();
});
it('classifies a post-dispatch response deadline as unknown, never as definite failure',async()=>{
 vi.useFakeTimers();const s=setup(),cap=s.client.capture();s.ready();await Promise.resolve();s.reply('captured',{targetToken:'t',target:{name:'Editor',pid:2,bundleId:'b'}});await cap;
 const first=s.client.insert('t','hello','id');const assertion=expect(first).rejects.toMatchObject({state:'unresolved'});await Promise.resolve();await vi.advanceTimersByTimeAsync(101);await assertion;
 await expect(s.client.insert('t','hello','id')).rejects.toMatchObject({state:'duplicate_blocked'});expect(s.requests).toHaveLength(2);s.child.exitCode=0;await s.client.dispose();
});
it('retains capability metadata and surfaces a known unsupported application as not dispatched without retry',async()=>{
 const s=setup(),cap=s.client.capture();s.ready();await Promise.resolve();s.reply('captured',{targetToken:'t',target:{name:'Electron',pid:2,bundleId:'com.github.Electron',capability:'blocked_known_incompatibility',frameworkVersion:'45.0.0'}});
 expect((await cap).target).toMatchObject({capability:'blocked_known_incompatibility',frameworkVersion:'45.0.0'});
 const insert=s.client.insert('t','hello','blocked-id');const assertion=expect(insert).rejects.toMatchObject({state:'not_dispatched'});await Promise.resolve();s.reply('not_dispatched');await assertion;
 await expect(s.client.insert('t','hello','blocked-id')).rejects.toMatchObject({state:'duplicate_blocked'});expect(s.requests).toHaveLength(2);s.child.exitCode=0;await s.client.dispose();
});
it("fails closed on an unsolicited or stale response", async () => {
  const s=setup(), call=s.client.capture();const rejected=expect(call).rejects.toThrow();s.ready();await Promise.resolve();s.child.stdout.write('{"requestId":"old","state":"confirmed","reason":"stale"}\n');await rejected;expect(s.child.kill).toHaveBeenCalled();s.child.exitCode=0;await s.client.dispose();
});
it('quarantines a user interruption of an outstanding mutation without allowing another send',async()=>{
 const s=setup(),capture=s.client.capture();s.ready();await Promise.resolve();s.reply('captured',{targetToken:'t',target:{name:'Editor',pid:2,bundleId:'local.editor'}});await capture;
 const inserted=s.client.insert('t','hello','transcript-a');const rejected=expect(inserted).rejects.toMatchObject({state:'unresolved'});await Promise.resolve();
 expect(s.requests.at(-1)?.operationId).toBe('transcript-a');s.client.cancelUnresolvedInsertion();await rejected;
 await expect(s.client.insert('t','hello','transcript-a')).rejects.toThrow();expect(s.requests).toHaveLength(2);s.child.exitCode=0;await s.client.dispose();
});

describe("adaptive production client", () => {
  async function captured() {
    const s = setup(true), call = s.client.capture(); s.ready(); await Promise.resolve();
    s.reply("captured", { targetToken: "t", target: { name: "Editor", pid: 2, bundleId: "b", insertability: "verified" } });
    expect((await call).target.insertability).toBe("verified");
    return s;
  }
  it("frees a transcript whose helper never started, and only that one", async () => {
    const s = setup(true);
    const first = s.client.insert("t", "hello", "startup-id");
    const refused = expect(first).rejects.toMatchObject({ state: "not_dispatched" });
    s.client.cancelUnresolvedInsertion();
    await refused;
    expect(s.requests).toHaveLength(0);

    const replacement = setup(true);
    const retried = s.client.insert("t", "hello", "startup-id");
    replacement.ready();
    await vi.waitFor(() => expect(replacement.requests.at(-1)).toMatchObject({ type: "insert", operationId: "startup-id" }));
    replacement.reply("confirmed");
    await retried;
    await expect(s.client.insert("t", "hello", "startup-id")).rejects.toMatchObject({ state: "duplicate_blocked" });
    expect(replacement.requests.filter(request => request.type === "insert")).toHaveLength(1);
  });
  it("keeps the claim on a transcript that reached the helper when the helper dies", async () => {
    const s = await captured();
    const sent = s.client.insert("t", "hello", "sent-id");
    await vi.waitFor(() => expect(s.requests.at(-1)).toMatchObject({ type: "insert" }));
    const rejected = expect(sent).rejects.toMatchObject({ state: "unresolved" });
    s.client.cancelUnresolvedInsertion();
    await rejected;
    await expect(s.client.insert("t", "hello", "sent-id")).rejects.toMatchObject({ state: "duplicate_blocked" });
    expect(s.requests.filter(request => request.type === "insert")).toHaveLength(1);
  });
  it("asks the helper for adaptive capture", async () => {
    const s = await captured();
    expect(s.requests[0]).toMatchObject({ type: "capture", adaptive: true, method: "native_paste" });
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("lets a refused operation ask again and marks the request as explicit", async () => {
    const s = await captured();
    const first = expect(s.client.insert("t", "hello", "op")).rejects.toMatchObject({ state: "not_dispatched" });
    await Promise.resolve(); s.reply("not_dispatched"); await first;
    const second = s.client.insert("t", "hello", "op", { explicit: true }); await Promise.resolve();
    expect(s.requests.at(-1)).toMatchObject({ type: "insert", explicit: true }); s.reply("unverified");
    expect(await second).toBe("unverified");
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("never resends a dispatched operation, yet keeps working for the next one", async () => {
    const s = await captured();
    const first = expect(s.client.insert("t", "hello", "op")).rejects.toMatchObject({ state: "unresolved" });
    await Promise.resolve(); s.reply("unresolved"); await first;
    await expect(s.client.insert("t", "hello", "op")).rejects.toMatchObject({ state: "duplicate_blocked" });
    const next = s.client.capture(); await Promise.resolve(); await Promise.resolve();
    s.reply("captured", { targetToken: "n", target: { name: "Editor", pid: 2, bundleId: "b" } });
    expect((await next).token).toBe("n");
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("starts a new helper after a crash, and the crash mid-insert stays unknown", async () => {
    const s = await captured();
    const lost = expect(s.client.insert("t", "hello", "op")).rejects.toMatchObject({ state: "unresolved" });
    await Promise.resolve(); s.child.emit("close"); await lost;
    expect(spawn).toHaveBeenCalledOnce();
    const replacement = setup(true); // Fresh fixture for the respawn; the old client spawns through the same mock.
    const next = s.client.capture().catch(() => undefined);
    replacement.child.stdout.write('{"type":"ready","protocol":3}\n'); await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(2);
    await s.client.dispose(); await next;
  });
  it("tells the service which app came to the front", async () => {
    const s = await captured(), seen = vi.fn(); s.client.onFrontmostChanged = seen;
    s.child.stdout.write('{"type":"frontmost","pid":77}\n');
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(77));
    expect(s.client.frontmostPid).toBe(77);
    s.child.exitCode = 0; await s.client.dispose();
  });
  const target = { name: "Editor", pid: 2, bundleId: "b" };
  it("lets an overlapping capture wait its turn instead of reporting the helper busy", async () => {
    const s = setup(true), first = s.client.capture(), second = s.client.capture(); s.ready();
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    s.reply("captured", { targetToken: "a", target });
    expect((await first).token).toBe("a");
    await vi.waitFor(() => expect(s.requests).toHaveLength(2));
    s.reply("captured", { targetToken: "b", target });
    expect((await second).token).toBe("b");
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("holds a capture behind an insertion that is still running", async () => {
    const s = await captured();
    const inserted = s.client.insert("t", "hello", "op");
    await vi.waitFor(() => expect(s.requests).toHaveLength(2));
    const next = s.client.capture();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(s.requests).toHaveLength(2);
    s.reply("confirmed"); await inserted;
    await vi.waitFor(() => expect(s.requests).toHaveLength(3));
    expect(s.requests.at(-1)?.type).toBe("capture");
    s.reply("captured", { targetToken: "n", target });
    expect((await next).token).toBe("n");
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("moves a waiting capture to a new helper when the one ahead of it dies", async () => {
    const s = setup(true), first = s.client.capture().catch(error => error), second = s.client.capture(); s.ready();
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    const replacement = setup(true);
    s.child.emit("close");
    expect(await first).toMatchObject({ state: "not_dispatched", answered: false });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    replacement.ready();
    await vi.waitFor(() => expect(replacement.requests).toHaveLength(1));
    replacement.reply("captured", { targetToken: "fresh", target });
    expect((await second).token).toBe("fresh");
    replacement.child.exitCode = 0; await s.client.dispose();
  });
  it.each([
    ["unparseable JSON", "not json\n"],
    ["half a message", '{"requestId":\n'],
    ["a reply to no request", '{"requestId":"old","state":"confirmed","reason":"stale"}\n']
  ])("reports %s from a live helper as answered, so no fallback runs", async (_label, line) => {
    const s = setup(true), call = s.client.capture().catch(error => error); s.ready();
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    s.child.stdout.write(line);
    expect(await call).toMatchObject({ state: "not_dispatched", answered: true });
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("keeps a framing failure during an insertion unknown, because Cmd-V may have gone out", async () => {
    const s = await captured();
    const lost = s.client.insert("t", "hello", "op").catch(error => error);
    await vi.waitFor(() => expect(s.requests).toHaveLength(2));
    s.child.stdout.write("not json\n");
    expect(await lost).toMatchObject({ state: "unresolved", answered: true });
    s.child.exitCode = 0; await s.client.dispose();
  });
  it("reports a dead helper as unavailable, so the fallback may run", async () => {
    const s = setup(true), call = s.client.capture().catch(error => error); s.ready();
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    s.child.emit("close");
    expect(await call).toMatchObject({ answered: false });
    await s.client.dispose();
  });
  it("never drops a held target to AppleScript because two captures overlapped", async () => {
    const s = setup(true);
    const service = new TextInsertionService({} as ClipboardBridgeService, undefined, undefined, s.client, true);
    const first = service.captureCurrentTargetApplication(), second = service.captureCurrentTargetApplication(); s.ready();
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    s.reply("captured", { targetToken: "old", target: { ...target, name: "Old" } });
    await vi.waitFor(() => expect(s.requests).toHaveLength(2));
    s.reply("captured", { targetToken: "new", target: { ...target, name: "New" } });
    await first; await second;
    expect(execFile).not.toHaveBeenCalled();
    expect(service.getCapturedTargetApplicationName()).toBe("New");
    expect(service.getRecoveryTargetMetadata()).toMatchObject({ name: "New" });
    s.child.exitCode = 0; await s.client.dispose();
  });
});
it("reselects the last insertion with a fresh token, and refuses when the field changed", async () => {
  const s=setup(), call=s.client.reselectLastInsertion();s.ready();await Promise.resolve();
  s.reply("captured",{targetToken:"again",reason:"inserted_text_selected"});expect(await call).toBe("again");
  const changed=s.client.reselectLastInsertion();const rejected=expect(changed).rejects.toMatchObject({state:"not_dispatched"});await Promise.resolve();s.reply("not_dispatched");await rejected;
  expect(s.requests.map(x=>x.type)).toEqual(["reselect","reselect"]);s.child.exitCode=0;await s.client.dispose();
});
