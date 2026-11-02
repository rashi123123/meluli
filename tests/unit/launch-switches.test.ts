/* @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";
import { debugSwitchesAllowed, findRefusedSwitch } from "@main/launch-switches";
import config from "../../electron.vite.config";

const refused = [
  "remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-allow-origins",
  "inspect", "inspect-brk", "inspect-port", "inspect-brk-node", "debug-port",
  "browser-subprocess-path", "renderer-cmd-prefix", "utility-cmd-prefix", "gpu-launcher", "plugin-launcher", "ppapi-plugin-launcher",
  "js-flags", "no-sandbox", "disable-gpu-sandbox", "no-zygote", "single-process", "in-process-gpu", "disable-web-security"
];

describe("findRefusedSwitch", () => {
  it.each(refused)("refuses --%s bare and with a value", name => {
    expect(findRefusedSwitch(["/Applications/Meluli.app/Contents/MacOS/Meluli", `--${name}`])).toBe(name);
    expect(findRefusedSwitch(["/Applications/Meluli.app/Contents/MacOS/Meluli", `--${name}=9222`])).toBe(name);
  });
  it("reads every spelling Chromium or Node accepts", () => {
    expect(findRefusedSwitch(["-remote-debugging-port=9222"])).toBe("remote-debugging-port");
    expect(findRefusedSwitch(["--inspect_brk=9229"])).toBe("inspect-brk");
    expect(findRefusedSwitch(["--Remote-Debugging-Port=9222"])).toBe("remote-debugging-port");
  });
  it("finds a refused switch behind harmless ones", () => {
    expect(findRefusedSwitch(["/app", "--use-fake-device-for-media-stream", "--no-sandbox"])).toBe("no-sandbox");
  });
  it("leaves a normal launch and the test flags alone", () => {
    expect(findRefusedSwitch(["/Applications/Meluli.app/Contents/MacOS/Meluli"])).toBeNull();
    expect(findRefusedSwitch(["/app", "-psn_0_1234567", "-NSDocumentRevisionsDebugMode", "YES", "-ApplePersistenceIgnoreState", "YES"])).toBeNull();
    expect(findRefusedSwitch(["/app", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--use-file-for-fake-audio-capture=/tmp/a.wav"])).toBeNull();
  });
  it("does not read a value or a file path as a switch", () => {
    expect(findRefusedSwitch(["/tmp/--no-sandbox", "--lang=--no-sandbox"])).toBeNull();
  });
});

describe("the test-only build", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("stays closed when the bundle did not define otherwise", () => {
    expect(debugSwitchesAllowed()).toBe(false);
  });
  it("opens only for a literal true", () => {
    vi.stubGlobal("__MELULI_ALLOW_DEBUG_SWITCHES__", "true");
    expect(debugSwitchesAllowed()).toBe(false);
    vi.stubGlobal("__MELULI_ALLOW_DEBUG_SWITCHES__", true);
    expect(debugSwitchesAllowed()).toBe(true);
  });
  const defineFor = (mode: string) => {
    const resolved = (config as (env: { command: "build"; mode: string }) => { main?: { define?: Record<string, string> } })({ command: "build", mode });
    return resolved.main?.define?.__MELULI_ALLOW_DEBUG_SWITCHES__;
  };
  it("is off in an ordinary build, whatever the environment says", () => {
    vi.stubEnv("MELULI_ALLOW_DEBUG_SWITCHES", "1");
    expect(defineFor("production")).toBe("false");
    vi.unstubAllEnvs();
  });
  it("is on only in the named build mode", () => {
    expect(defineFor("debug-switches")).toBe("true");
  });
});
