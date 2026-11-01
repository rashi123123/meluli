import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophoneCheck } from "@/hooks/use-microphone-check";
import { he } from "@shared/locale";
import type { MicrophonePermissionStatus } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
class TestTrack extends EventTarget {
  readyState = "live";
  muted = false;
  stop = vi.fn(() => { this.readyState = "ended"; });
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
function stream(track = new TestTrack()) {
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
class TestAudioContext {
  static instances: TestAudioContext[] = [];
  static startSuspended = false;
  state = TestAudioContext.startSuspended ? "suspended" : "running";
  amplitude = 0;
  source = { connect: vi.fn(), disconnect: vi.fn() };
  analyser = {
    fftSize: 1024, smoothingTimeConstant: 0,
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
      for (let index = 0; index < samples.length; index++) samples[index] = index % 2 ? this.amplitude : -this.amplitude;
    })
  };
  createAnalyser = vi.fn(() => this.analyser);
  createMediaStreamSource = vi.fn(() => this.source);
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => { this.state = "running"; });
  constructor() { TestAudioContext.instances.push(this); }
}
let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
let current: ReturnType<typeof useMicrophoneCheck>;
let getUserMedia: ReturnType<typeof vi.fn>;
let permission: ReturnType<typeof vi.fn<() => Promise<MicrophonePermissionStatus>>>;
let input: ReturnType<typeof stream>;
let hidden: boolean;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
function Harness({ enabled = true, deviceId }: { enabled?: boolean; deviceId?: string }) {
  current = useMicrophoneCheck({ enabled, deviceId, onRequestPermission: permission });
  return null;
}
async function render(props: { enabled?: boolean; deviceId?: string } = {}) { await act(async () => root.render(<Harness {...props} />)); }
async function frame(now: number) {
  await act(async () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  });
}
async function visibility(value: boolean) {
  await act(async () => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); });
}
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); mounted = true;
  input = stream(); hidden = false; frames = new Map(); frameId = 0;
  permission = vi.fn<() => Promise<MicrophonePermissionStatus>>().mockResolvedValue("granted");
  getUserMedia = vi.fn().mockResolvedValue(input.value);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  TestAudioContext.instances = []; TestAudioContext.startSuspended = false;
  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("real microphone signal check", () => {
  it("opens nothing until explicitly started and never connects input to speakers", async () => {
    await render(); expect(current.status).toBe("idle"); expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => current.start());
    expect(permission).toHaveBeenCalledOnce(); expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
    const audio = TestAudioContext.instances[0];
    expect(audio.source.connect).toHaveBeenCalledExactlyOnceWith(audio.analyser);
    expect(current.status).toBe("listening"); expect(current.level).toBe(0); expect(current.hasDetected).toBe(false);
  });

  it("requires sustained real input, then keeps the level responsive after detection", async () => {
    await render(); await act(async () => current.start());
    const audio = TestAudioContext.instances[0]; audio.amplitude = 0.05;
    for (const now of [0, 40, 80, 120, 160, 200]) await frame(now);
    expect(current.status).toBe("listening"); expect(current.level).toBeCloseTo(0.4);
    await frame(240); expect(current.status).toBe("detected"); expect(current.hasDetected).toBe(true);
    audio.amplitude = 0; await frame(280); expect(current.level).toBe(0); expect(current.hasDetected).toBe(true);
    audio.amplitude = 1; await frame(320); expect(current.level).toBe(1);
  });

  it("does not count one noisy frame, subthreshold noise, a muted track, or an unobserved delay as detection", async () => {
    await render(); await act(async () => current.start());
    const audio = TestAudioContext.instances[0]; audio.amplitude = 0.1;
    await frame(0); audio.amplitude = 0; await frame(40);
    audio.amplitude = 0.005;
    for (const now of [80, 120, 160, 200, 240, 280, 320]) await frame(now);
    expect(current.hasDetected).toBe(false);
    audio.amplitude = 0.1; input.track.muted = true;
    for (const now of [360, 400, 440, 480, 520, 560, 600]) await frame(now);
    expect(current.level).toBe(0); expect(current.hasDetected).toBe(false);
    input.track.muted = false; await frame(640); await frame(1000);
    expect(current.hasDetected).toBe(false);
  });

  it("prevents duplicate starts while permission and input acquisition are pending", async () => {
    const granted = deferred<MicrophonePermissionStatus>(); const acquired = deferred<MediaStream>();
    permission.mockReturnValue(granted.promise); getUserMedia.mockReturnValue(acquired.promise);
    await render(); await act(async () => { void current.start(); void current.start(); });
    expect(permission).toHaveBeenCalledOnce();
    await act(async () => granted.resolve("granted")); await act(async () => current.start());
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => acquired.resolve(input.value)); expect(TestAudioContext.instances).toHaveLength(1);
  });

  it("surfaces permission denial without opening input and can retry", async () => {
    permission.mockResolvedValueOnce("denied");
    await render(); await act(async () => current.start());
    expect(current.status).toBe("error"); expect(current.error).toContain("אין הרשאה"); expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => current.start()); expect(current.status).toBe("listening"); expect(current.error).toBeNull();
  });

  it("preserves the provider's Hebrew permission rejection and remains retryable", async () => {
    permission.mockRejectedValueOnce(new Error(he.permissionNeeded));
    await render(); await act(async () => current.start());
    expect(current.status).toBe("error"); expect(current.error).toBe(he.permissionNeeded); expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => current.start()); expect(current.status).toBe("listening"); expect(current.error).toBeNull();
  });

  it.each([
    ["NotAllowedError", "אין הרשאה"], ["NotFoundError", "לא מצאנו"], ["OverconstrainedError", "לא מצאנו"], ["NotReadableError", "משתמשת בו"]
  ])("makes %s actionable in Hebrew", async (name, message) => {
    getUserMedia.mockRejectedValue(new DOMException("native details", name));
    await render(); await act(async () => current.start());
    expect(current.status).toBe("error"); expect(current.error).toContain(message); expect(current.error).not.toContain("native details");
    expect(TestAudioContext.instances).toHaveLength(0);
  });

  it("reports a stream with no live audio device and releases all its tracks", async () => {
    input.track.readyState = "ended";
    await render(); await act(async () => current.start());
    expect(current.status).toBe("error"); expect(current.error).toContain("לא מצאנו"); expect(input.track.stop).toHaveBeenCalledOnce();
    expect(TestAudioContext.instances).toHaveLength(0);
  });

  it("reports a disconnected microphone and releases its analyser and animation frame", async () => {
    await render(); await act(async () => current.start());
    const audio = TestAudioContext.instances[0]; await act(async () => input.track.end());
    expect(current.status).toBe("error"); expect(current.error).toContain("נותק");
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(audio.source.disconnect).toHaveBeenCalledOnce();
    expect(audio.close).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
  });
});

describe("microphone ownership and late completion", () => {
  it("does not request permission while another owner makes the check unavailable", async () => {
    await render({ enabled: false }); await act(async () => current.start());
    expect(permission).not.toHaveBeenCalled(); expect(getUserMedia).not.toHaveBeenCalled(); expect(current.status).toBe("idle");
  });

  it("ignores permission completion after being disabled", async () => {
    const granted = deferred<MicrophonePermissionStatus>(); permission.mockReturnValue(granted.promise);
    await render(); await act(async () => { void current.start(); }); await render({ enabled: false });
    await act(async () => granted.resolve("granted"));
    expect(getUserMedia).not.toHaveBeenCalled(); expect(current.status).toBe("idle");
  });

  it("stops a late input stream after being disabled without creating an audio graph", async () => {
    const acquired = deferred<MediaStream>(); getUserMedia.mockReturnValue(acquired.promise);
    await render(); await act(async () => { void current.start(); }); await render({ enabled: false });
    await act(async () => acquired.resolve(input.value));
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(TestAudioContext.instances).toHaveLength(0); expect(current.status).toBe("idle");
  });

  it("releases a late input stream after unmount", async () => {
    const acquired = deferred<MediaStream>(); getUserMedia.mockReturnValue(acquired.promise);
    await render(); await act(async () => { void current.start(); });
    await act(async () => root.unmount()); mounted = false;
    await act(async () => acquired.resolve(input.value));
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(TestAudioContext.instances).toHaveLength(0);
  });

  it("releases an active graph and input on unmount", async () => {
    await render(); await act(async () => current.start()); const audio = TestAudioContext.instances[0];
    await act(async () => root.unmount()); mounted = false;
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(audio.source.disconnect).toHaveBeenCalledOnce();
    expect(audio.analyser.disconnect).toHaveBeenCalledOnce(); expect(audio.close).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
  });

  it("does not let an old acquisition stop or replace a later retry", async () => {
    const old = deferred<MediaStream>(); const newer = stream(); getUserMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce(newer.value);
    await render(); await act(async () => { void current.start(); }); await act(async () => current.stop());
    await act(async () => current.start()); await act(async () => old.resolve(input.value));
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(newer.track.stop).not.toHaveBeenCalled();
    expect(current.status).toBe("listening"); expect(TestAudioContext.instances).toHaveLength(1);
  });

  it("releases every resource on stop, removes ended handlers, and resets detection", async () => {
    await render(); await act(async () => current.start());
    const audio = TestAudioContext.instances[0]; audio.amplitude = 0.05;
    for (const now of [0, 40, 80, 120, 160, 200, 240]) await frame(now);
    await act(async () => { current.stop(); current.stop(); });
    expect(current.status).toBe("idle"); expect(current.hasDetected).toBe(false); expect(current.level).toBe(0);
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(audio.close).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
    await act(async () => input.track.end()); expect(current.status).toBe("idle");
  });

  it("stops when hidden and requires a new explicit start when visible again", async () => {
    await render(); await act(async () => current.start()); await visibility(true);
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(TestAudioContext.instances[0].close).toHaveBeenCalledOnce();
    expect(current.status).toBe("idle"); expect(frames.size).toBe(0);
    await act(async () => current.start()); expect(getUserMedia).toHaveBeenCalledOnce();
    await visibility(false); expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("does not acquire input after a pending permission request is hidden", async () => {
    const granted = deferred<MicrophonePermissionStatus>(); permission.mockReturnValue(granted.promise);
    await render(); await act(async () => { void current.start(); }); await visibility(true);
    await act(async () => granted.resolve("granted")); await visibility(false);
    expect(getUserMedia).not.toHaveBeenCalled(); expect(current.status).toBe("idle");
  });

  it("releases the old device before allowing the newly selected device", async () => {
    await render({ deviceId: "first" }); await act(async () => current.start());
    await render({ deviceId: "second" }); expect(input.track.stop).toHaveBeenCalledOnce(); expect(current.status).toBe("idle");
    getUserMedia.mockResolvedValue(stream().value); await act(async () => current.start());
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "second" } }, video: false });
  });

  it("releases a suspended context while resume is pending, then ignores its completion", async () => {
    TestAudioContext.startSuspended = true;
    const resumed = deferred<void>();
    // Hold acquisition to install a deferred resume before the hook reaches it.
    const acquired = deferred<MediaStream>(); getUserMedia.mockReturnValue(acquired.promise);
    await render(); await act(async () => { void current.start(); });
    vi.stubGlobal("AudioContext", class extends TestAudioContext {
      override resume = vi.fn(() => resumed.promise);
    });
    await act(async () => acquired.resolve(input.value));
    const audio = TestAudioContext.instances[0]; await render({ enabled: false });
    expect(audio.close).toHaveBeenCalledOnce(); expect(input.track.stop).toHaveBeenCalledOnce();
    await act(async () => resumed.resolve()); expect(current.status).toBe("idle"); expect(frames.size).toBe(0);
  });

  it("releases input when resuming the audio graph fails", async () => {
    TestAudioContext.startSuspended = true;
    vi.stubGlobal("AudioContext", class extends TestAudioContext {
      override resume = vi.fn(async () => { throw new Error("Audio service unavailable"); });
    });
    await render(); await act(async () => current.start());
    expect(current.status).toBe("error"); expect(current.error).toContain("בדיקת המיקרופון לא התחילה");
    expect(input.track.stop).toHaveBeenCalledOnce(); expect(TestAudioContext.instances[0].close).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
  });
});
