/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { NativeInsertionClient } from "@main/services/native-insertion-client";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
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
});
