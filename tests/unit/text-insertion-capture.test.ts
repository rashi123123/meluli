/* @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from "vitest";
const { callbacks } = vi.hoisted(() => ({ callbacks: [] as Array<(error: Error | null, stdout: string, stderr: string) => void> }));
vi.mock("node:child_process", () => ({ execFile: vi.fn((_file, _args, _options, callback) => { callbacks.push(callback); return { stdin: { end: vi.fn(), on: vi.fn() } }; }) }));
const { trusted } = vi.hoisted(() => ({ trusted: vi.fn((_prompt: boolean) => true) }));
vi.mock("electron", () => ({ systemPreferences: { isTrustedAccessibilityClient: trusted } }));
import { TextInsertionService } from "@main/services/text-insertion.service";
import { NativeInsertionFailure } from "@main/services/native-insertion-client";
import { ClipboardUnavailableError, type ClipboardBridgeService } from "@main/services/clipboard-bridge.service";
import { he } from "@shared/locale";
let service: TextInsertionService;
beforeEach(() => { callbacks.length = 0; service = new TextInsertionService({} as ClipboardBridgeService); });
describe("target capture ordering (simulated OS responses)", () => {
  it("does not let an older foreground query overwrite the latest selected app", async () => {
    const old = service.captureCurrentTargetApplication();
    const current = service.captureCurrentTargetApplication();
    callbacks[1](null, "Current editor\norg.example.current\n12345", "");
    await current;
    callbacks[0](null, "Previous editor\norg.example.previous\n12344", "");
    await old;
    expect(service.getCapturedTargetApplicationName()).toBe("Current editor");
  });
  it("lets a recording start wait for a capture that is still running", async () => {
    await service.whenCaptureSettled();
    const pending = service.captureCurrentTargetApplication();
    let settled = false;
    const waited = service.whenCaptureSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    callbacks[0](null, "Editor\norg.example.editor\n12345", "");
    await pending; await waited;
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
  });
  it("recognises dictation into Meluli itself and forgets it with the target", async () => {
    const pending = service.captureCurrentTargetApplication();
    callbacks[0](null, `Meluli\norg.example.meluli\n${process.pid}`, "");
    await pending;
    expect(service.getCapturedTargetApplicationName()).toBeNull();
    expect(service.isOwnWindowTarget()).toBe(true);
    service.clearTargetApplication();
    expect(service.isOwnWindowTarget()).toBe(false);
  });
  it("keeps the real target when the recorder window itself has focus", async () => {
    const first = service.captureCurrentTargetApplication();
    callbacks[0](null, "Editor\norg.example.editor\n12345", "");
    await first;
    const second = service.captureCurrentTargetApplication();
    callbacks[1](null, `Meluli\norg.example.meluli\n${process.pid}`, "");
    await second;
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
    expect(service.isOwnWindowTarget()).toBe(false);
  });
  it("does not resurrect a target after its recording session has cleared it", async () => {
    const pending = service.captureCurrentTargetApplication();
    service.clearTargetApplication();
    callbacks[0](null, "Old editor\norg.example.old\n12345", "");
    await pending;
    expect(service.getCapturedTargetApplicationName()).toBeNull();
  });
  it.each([
    ["a newline before a forged pid", "Evil\norg.evil\n999\norg.real\n12345"],
    ["a newline that claims Meluli itself", `Evil\nx\n${process.pid}\norg.real\n12345`],
    ["a carriage return", "Evil\rApp\norg.real\n12345"],
    ["a line separator", `Evil${String.fromCharCode(0x2028)}App\norg.real\n12345`]
  ])("refuses a System Events app name with %s", async (_label, stdout) => {
    const pending = service.captureCurrentTargetApplication();
    callbacks[0](null, stdout, "");
    expect(await pending).toBeNull();
    expect(service.isOwnWindowTarget()).toBe(false);
  });
  it("keeps the helper's pid whatever the app calls itself", async () => {
    const insert = vi.fn(async () => "confirmed" as const);
    service = new TextInsertionService({} as ClipboardBridgeService, undefined, undefined,
      { capture: async () => ({ target: { name: `Evil\nx\n${process.pid}`, pid: 12345, bundleId: "org.real" }, token: "t" }), insert });
    expect(await service.captureCurrentTargetApplication()).toEqual({ name: `Evil\nx\n${process.pid}`, pid: 12345, bundleId: "org.real" });
    expect(service.isOwnWindowTarget()).toBe(false);
  });
  it("keeps the research helper's pid whatever the app calls itself", async () => {
    service = new TextInsertionService({} as ClipboardBridgeService, undefined, "/research/native-paste");
    const pending = service.captureCurrentTargetApplication();
    callbacks[0](null, JSON.stringify({ name: "Evil\nx\n999", bundleId: "org.real", pid: 12345 }), "");
    expect(await pending).toEqual({ name: "Evil\nx\n999", pid: 12345, bundleId: "org.real" });
  });
});


describe("paste error recovery (simulated OS responses)", () => {
  it.each([
    ["", "paste_failed"],
    ["execution error: target app did not become active", "target_unavailable"]
  ])("classifies stderr %j without inspecting echoed command text", async (stderr, code) => {
    const restoreClipboard = vi.fn(async () => {});
    const restoreOverlay = vi.fn();
    service = new TextInsertionService({ begin: async () => ({ restore: restoreClipboard }) } as unknown as ClipboardBridgeService, () => restoreOverlay);
    const capture = service.captureCurrentTargetApplication();
    callbacks[0](null, "Editor\norg.example.editor\n12345", "");
    await capture;
    const inserting = service.insertIntoCapturedTarget("public test text");
    const assertion = expect(inserting).rejects.toMatchObject({ code });
    await Promise.resolve();
    callbacks[1](new Error('Command failed: osascript -e error "target app did not become active"'), "", stderr);
    await assertion;
    expect(restoreClipboard).toHaveBeenCalledOnce();
    expect(restoreOverlay).toHaveBeenCalledOnce();
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
  });
});

describe("research acknowledged insertion (simulated native responses)", () => {
  it.each(["uncertain", "not_dispatched", "unknown"])("restores clipboard and never redispatches on %s", async state => {
    const restore = vi.fn(async () => {}), overlay = vi.fn();
    service = new TextInsertionService({ begin: async () => ({ restore }) } as unknown as ClipboardBridgeService, () => overlay, "/research/native-paste");
    const capture = service.captureCurrentTargetApplication();
    callbacks[0](null, JSON.stringify({ name: "Editor", bundleId: "org.editor", pid: 12345 }), "");
    await capture;
    const inserting = service.insertIntoCapturedTarget("שלום dashboard");
    const rejected = expect(inserting).rejects.toMatchObject({ code: "paste_failed" });
    await Promise.resolve();
    callbacks[1](new Error("native failed"), JSON.stringify({ state, reason: "lost_focus_or_interruption" }), "");
    await rejected;
    expect(callbacks).toHaveLength(2); // capture + exactly one insertion invocation
    expect(restore).toHaveBeenCalledOnce(); expect(overlay).toHaveBeenCalledOnce();
  });
  it("accepts exact text acknowledgment, blocks overlap and restores once without the legacy delay", async () => {
    const restore = vi.fn(async () => {});
    service = new TextInsertionService({ begin: async () => ({ restore }) } as unknown as ClipboardBridgeService, () => () => {}, "/research/native-paste");
    const capture = service.captureCurrentTargetApplication();
    callbacks[0](null, JSON.stringify({ name: "Editor", bundleId: "org.editor", pid: 12345 }), ""); await capture;
    const inserting = service.insertIntoCapturedTarget("שלום"); await Promise.resolve();
    await expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "paste_failed" });
    callbacks[1](null, JSON.stringify({ state: "confirmed", reason: "exact_value_observed" }), "");
    expect(await inserting).toBe(true); expect(restore).toHaveBeenCalledOnce();
    expect(service.getLastInsertionOutcome()).toBe("confirmed");
    expect(service.getCapturedTargetApplicationName()).toBeNull(); expect(callbacks).toHaveLength(2);
    await expect(service.insertIntoCapturedTarget("new session")).rejects.toMatchObject({ code: "target_unavailable" });
    expect(service.getLastInsertionOutcome()).toBe("not_dispatched");
  });
});

describe('persistent AX insertion isolation',()=>{
 it('passes a stable transcript operation ID and never opens a clipboard lease',async()=>{
  const begin=vi.fn(),overlay=vi.fn(),insert=vi.fn(async()=>'confirmed' as const);
  service=new TextInsertionService({begin}as unknown as ClipboardBridgeService,()=>overlay,undefined,
   {capture:async()=>({target:{name:'Editor',pid:2,bundleId:'local.editor'},token:'capture-token'}),insert});
  await service.captureCurrentTargetApplication();expect(await service.insertIntoCapturedTarget('שלום GitHub','transcript-id')).toBe(true);
  expect(insert).toHaveBeenCalledWith('capture-token','שלום GitHub','transcript-id',{});expect(begin).not.toHaveBeenCalled();expect(callbacks).toHaveLength(0);expect(overlay).toHaveBeenCalledOnce();expect(service.getLastInsertionOutcome()).toBe('confirmed');
 });
});
describe('persistent native paste clipboard ownership',()=>{
 it('holds one clipboard lease through confirmation and restores once',async()=>{
  const restore=vi.fn(async()=>{}),quarantine=vi.fn(async()=>{}),begin=vi.fn(async()=>({restore,quarantine}));
  const insert=vi.fn(async()=>{expect(restore).not.toHaveBeenCalled();return 'confirmed' as const});
  service=new TextInsertionService({begin}as unknown as ClipboardBridgeService,()=>()=>{},undefined,
   {usesClipboard:true,capture:async()=>({target:{name:'Electron',pid:2,bundleId:'com.github.Electron'},token:'t'}),insert});
  await service.captureCurrentTargetApplication();expect(await service.insertIntoCapturedTarget('עברית API ארוכה','transcript-one')).toBe(true);
  expect(begin).toHaveBeenCalledOnce();expect(insert).toHaveBeenCalledOnce();expect(restore).toHaveBeenCalledOnce();expect(quarantine).not.toHaveBeenCalled();expect(service.getLastInsertionOutcome()).toBe('confirmed');
 });
 it('keeps an ambiguous clipboard payload quarantined and never resends',async()=>{
  const restore=vi.fn(async()=>{}),quarantine=vi.fn(async()=>{}),insert=vi.fn(async()=>{throw new Error('unknown outcome')});
  service=new TextInsertionService({begin:async()=>({restore,quarantine})}as unknown as ClipboardBridgeService,()=>()=>{},undefined,
   {usesClipboard:true,capture:async()=>({target:{name:'Electron',pid:2,bundleId:'com.github.Electron'},token:'t'}),insert});
  await service.captureCurrentTargetApplication();await expect(service.insertIntoCapturedTarget('text','id')).rejects.toThrow();
  expect(quarantine).toHaveBeenCalledOnce();expect(restore).not.toHaveBeenCalled();expect(insert).toHaveBeenCalledOnce();expect(service.getLastInsertionOutcome()).toBe('unresolved');
 });
});

describe("production native paste with the AppleScript fallback (simulated responses)", () => {
  const target = { name: "Editor", pid: 12345, bundleId: "org.editor" };
  const legacyCapture = "Editor\norg.editor\n12345";
  const refused = (reason: string) => new NativeInsertionFailure("not_dispatched", reason);
  function production(native: { capture?: () => Promise<{ target: typeof target; token: string }>; insert?: () => Promise<"confirmed" | "unverified"> } = {}, quarantine = vi.fn(async () => {})) {
    const restore = vi.fn(async () => {}), overlay = vi.fn();
    const begin = vi.fn(async () => ({ restore, quarantine }));
    const capture = vi.fn(native.capture ?? (async () => ({ target, token: "token" })));
    const insert = vi.fn(native.insert ?? (async () => "confirmed" as const));
    const client: { usesClipboard: boolean; capture: typeof capture; insert: typeof insert; onFrontmostChanged?: ((pid: number) => void) | null } = { usesClipboard: true, capture, insert };
    service = new TextInsertionService({ begin } as unknown as ClipboardBridgeService, () => overlay, undefined, client as never, true);
    return { begin, capture, insert, overlay, quarantine, restore, native: client };
  }
  const answerOsaScript = async (index: number, stderr = "") => {
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(index));
    callbacks[index](stderr ? new Error(stderr) : null, index === 0 ? legacyCapture : "", stderr);
  };

  describe("a capture that arrives while the helper is answering another", () => {
    const held = () => {
      const replies: Array<(value: { target: typeof target; token: string }) => void> = [];
      const failures: Array<(error: Error) => void> = [];
      const capture = () => new Promise<{ target: typeof target; token: string }>((resolve, reject) => { replies.push(resolve); failures.push(reject); });
      return { capture, replies, failures };
    };
    const newest = { name: "Newest", bundleId: "org.example.newest", pid: 54321 };

    it("waits its turn on the helper and keeps the verified path for the paste", async () => {
      const { capture, replies } = held();
      const { capture: native, insert } = production({ capture });
      const blur = service.captureCurrentTargetApplication();
      const press = service.captureCurrentTargetApplication();
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(native).toHaveBeenCalledOnce();
      replies[0]!({ target, token: "blur" });
      await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
      replies[1]!({ target: newest, token: "press" });
      await Promise.all([blur, press]);
      expect(callbacks).toHaveLength(0);
      expect(service.getCapturedTargetApplicationName()).toBe("Newest");
      await service.insertIntoCapturedTarget("שלום");
      expect(insert.mock.calls[0]).toContain("press");
      expect(callbacks).toHaveLength(0);
    });

    it("sends only the newest of the waiting captures to the helper", async () => {
      const { capture, replies } = held();
      const { capture: native } = production({ capture });
      const all = [service.captureCurrentTargetApplication(), service.captureCurrentTargetApplication(), service.captureCurrentTargetApplication()];
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      replies[0]!({ target, token: "first" });
      await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
      replies[1]!({ target: newest, token: "third" });
      await Promise.all(all);
      expect(native).toHaveBeenCalledTimes(2);
      expect(callbacks).toHaveLength(0);
      expect(service.getCapturedTargetApplicationName()).toBe("Newest");
    });

    it("still takes the fallback when the capture it waited on stalled the helper", async () => {
      const { capture, failures } = held();
      const { capture: native } = production({ capture });
      const stalled = service.captureCurrentTargetApplication();
      const press = service.captureCurrentTargetApplication();
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      native.mockRejectedValueOnce(new NativeInsertionFailure("unresolved", "Native insertion requires manual recovery; no automatic restart."));
      failures[0]!(new NativeInsertionFailure("not_dispatched", "Native response deadline; inspect target before recovery."));
      await answerOsaScript(0);
      await Promise.all([stalled, press]);
      expect(callbacks).toHaveLength(1);
      expect(service.getCapturedTargetApplicationName()).toBe("Editor");
    });
  });

  it("names a clipboard it could not preserve, sends nothing and leaves Retry to the person", async () => {
    const { begin, capture, insert, overlay } = production();
    begin.mockRejectedValueOnce(new ClipboardUnavailableError("Clipboard helper unavailable."));
    await service.captureCurrentTargetApplication();
    await expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "clipboard_unavailable", message: he.textInsertionClipboardUnavailable });
    expect(insert).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledOnce();
    expect(overlay).toHaveBeenCalledOnce();
    expect(service.getLastInsertionOutcome()).toBe("not_dispatched");
    expect(service.hasUnknownNativeOutcome()).toBe(false);
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
  });

  it("uses the verified path without AppleScript and restores the clipboard at once", async () => {
    const { begin, insert, restore } = production();
    await service.captureCurrentTargetApplication();
    expect(await service.insertIntoCapturedTarget("שלום")).toBe(true);
    expect(insert).toHaveBeenCalledWith("token", "שלום", undefined, {});
    expect(callbacks).toHaveLength(0); expect(begin).toHaveBeenCalledOnce(); expect(restore).toHaveBeenCalledOnce();
    expect(service.getLastInsertionOutcome()).toBe("confirmed");
    expect(trusted).toHaveBeenLastCalledWith(true);
  });

  it("falls back to the existing capture and paste for a field the helper cannot read", async () => {
    const { begin, insert, quarantine, restore } = production({ capture: async () => { throw refused("unsupported_control"); } });
    const capture = service.captureCurrentTargetApplication();
    await answerOsaScript(0); await capture;
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
    const inserting = service.insertIntoCapturedTarget("שלום");
    await answerOsaScript(1);
    expect(await inserting).toBe(true);
    expect(insert).not.toHaveBeenCalled(); expect(begin).toHaveBeenCalledOnce();
    expect(quarantine).toHaveBeenCalledOnce(); expect(restore).not.toHaveBeenCalled();
    expect(service.getLastInsertionOutcome()).toBe("command_completed_unverified");
    expect(service.hasUnknownNativeOutcome()).toBe(false);
  });

  it("refuses a capture a live helper could not frame, rather than guessing with AppleScript", async () => {
    const { insert } = production({ capture: async () => { throw new NativeInsertionFailure("not_dispatched", "Invalid native response.", true); } });
    expect(await service.captureCurrentTargetApplication()).toBeNull();
    expect(callbacks).toHaveLength(0);
    await expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "target_unavailable" });
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    ["field_unreadable", "target_changed"], ["focus_moved", "target_changed"], ["target_not_active", "target_changed"],
    ["selection_changed", "target_changed"], ["secure_field", "secure_field"], ["target_closed", "target_unavailable"],
    ["stale_target", "target_unavailable"], ["clipboard_changed", "clipboard_changed"], ["accessibility_permission", "permission"]
  ])("treats helper refusal %s as final, so nothing reaches the blind path", async (reason, code) => {
    const { insert, restore } = production({ insert: async () => { throw refused(reason); } });
    await service.captureCurrentTargetApplication();
    await expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code });
    expect(callbacks).toHaveLength(0); expect(insert).toHaveBeenCalledOnce(); expect(restore).toHaveBeenCalledOnce();
    expect(service.getLastInsertionOutcome()).toBe("not_dispatched"); expect(service.hasUnknownNativeOutcome()).toBe(false);
  });

  it("keeps the target after a refusal, so asking again reaches the helper and may move focus", async () => {
    let attempts = 0;
    const { insert } = production({ insert: async () => {
      if (++attempts === 1) throw refused("target_not_active");
      return "confirmed";
    } });
    await service.captureCurrentTargetApplication();
    await expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "target_changed" });
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
    expect(await service.insertIntoCapturedTarget("שלום", undefined, { explicit: true })).toBe(true);
    expect(insert).toHaveBeenLastCalledWith("token", "שלום", undefined, { explicit: true });
    expect(service.getCapturedTargetApplicationName()).toBeNull();
  });

  it("reports a paste it could not read back as sent, not as confirmed", async () => {
    production({ insert: async () => "unverified" });
    await service.captureCurrentTargetApplication();
    expect(await service.insertIntoCapturedTarget("שלום")).toBe(true);
    expect(service.getLastInsertionOutcome()).toBe("dispatched_unverified");
    expect(service.hasUnknownNativeOutcome()).toBe(false);
  });

  it("keeps the payload through an unverified paste, so a slow target cannot read the old clipboard", async () => {
    let release = () => {};
    const quarantine = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const { begin, overlay, restore } = production({ insert: async () => "unverified" }, quarantine);
    await service.captureCurrentTargetApplication();
    expect(await service.insertIntoCapturedTarget("שלום")).toBe(true);
    expect(quarantine).toHaveBeenCalledOnce(); expect(restore).not.toHaveBeenCalled(); expect(overlay).toHaveBeenCalledOnce();
    await service.captureCurrentTargetApplication();
    const next = service.insertIntoCapturedTarget("המשך");
    await Promise.resolve();
    expect(begin).toHaveBeenCalledOnce();
    release();
    expect(await next).toBe(true); expect(begin).toHaveBeenCalledTimes(2);
  });

  it("keeps the held target when Meluli itself is frontmost at a later capture", async () => {
    let frontmostIsMeluli = false;
    production({ capture: async () => {
      if (frontmostIsMeluli) throw refused("own_application");
      return { target: { name: "Editor", pid: 2, bundleId: "local.editor" }, token: "token" };
    } });
    await service.captureCurrentTargetApplication();
    frontmostIsMeluli = true;
    await service.captureCurrentTargetApplication();
    expect(callbacks).toHaveLength(0);
    expect(service.getCapturedTargetApplicationName()).toBe("Editor");
    expect(service.isOwnWindowTarget()).toBe(false);
  });

  it("follows the frontmost app, counting Meluli's own windows as still dictating", async () => {
    const { native } = production();
    const notify = vi.fn(); service.onFrontmostChanged = notify;
    expect(service.isAttentionOnTarget()).toBe(true);
    await service.captureCurrentTargetApplication();
    expect(service.isAttentionOnTarget()).toBe(true);
    native.onFrontmostChanged?.(99);
    expect(service.isAttentionOnTarget()).toBe(false); expect(notify).toHaveBeenCalledOnce();
    native.onFrontmostChanged?.(process.pid);
    expect(service.isAttentionOnTarget()).toBe(true);
    native.onFrontmostChanged?.(target.pid);
    expect(service.isAttentionOnTarget()).toBe(true);
  });

  it("reports an unknown outcome now, never pastes again, and holds the next insertion behind the clipboard", async () => {
    let release = () => {};
    const quarantine = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    let attempts = 0;
    const { begin, overlay, restore } = production({ insert: async () => {
      if (++attempts === 1) throw new NativeInsertionFailure("unresolved", "mutation_not_confirmed");
      return "confirmed";
    } }, quarantine);
    await service.captureCurrentTargetApplication();
    await expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "paste_failed" });
    expect(service.hasUnknownNativeOutcome()).toBe(true); expect(service.getLastInsertionOutcome()).toBe("unresolved");
    expect(callbacks).toHaveLength(0); expect(quarantine).toHaveBeenCalledOnce(); expect(restore).not.toHaveBeenCalled();
    expect(overlay).toHaveBeenCalledOnce();

    await service.captureCurrentTargetApplication();
    const next = service.insertIntoCapturedTarget("המשך");
    await Promise.resolve();
    expect(begin).toHaveBeenCalledOnce();
    release();
    expect(await next).toBe(true); expect(begin).toHaveBeenCalledTimes(2);
    expect(service.hasUnknownNativeOutcome()).toBe(false);
  });

  it("keeps an AppleScript failure recoverable and unquarantined when it proves Cmd-V was not sent", async () => {
    const { quarantine, restore } = production({ capture: async () => { throw refused("unsupported_control"); } });
    const capture = service.captureCurrentTargetApplication();
    await answerOsaScript(0); await capture;
    const failed = expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "target_unavailable" });
    await answerOsaScript(1, "execution error: target app did not become active"); await failed;
    expect(quarantine).not.toHaveBeenCalled(); expect(restore).toHaveBeenCalledOnce();
    expect(service.hasUnknownNativeOutcome()).toBe(false);
    expect(service.getLastInsertionOutcome()).toBe("not_dispatched");
  });

  it.each([
    ["a timeout with no stderr", Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), ""],
    ["an unexplained failure", new Error("failed"), "failed"]
  ])("treats %s as unknown, because Cmd-V may already have been sent", async (_label, error, stderr) => {
    const { quarantine, restore } = production({ capture: async () => { throw refused("unsupported_control"); } });
    const capture = service.captureCurrentTargetApplication();
    await answerOsaScript(0); await capture;
    const failed = expect(service.insertIntoCapturedTarget("שלום")).rejects.toMatchObject({ code: "paste_failed" });
    await vi.waitFor(() => expect(callbacks.length).toBe(2));
    callbacks[1](error, "", stderr); await failed;
    expect(quarantine).toHaveBeenCalledOnce(); expect(restore).not.toHaveBeenCalled();
    expect(service.hasUnknownNativeOutcome()).toBe(true);
    expect(service.getLastInsertionOutcome()).toBe("unresolved");
  });

});
