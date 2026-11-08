import { describe, expect, it } from "vitest";
import { BROWSER_CALL_END_AFTER_MS, CALL_END_AFTER_MS, CallDetector, SUGGEST_AFTER_MS } from "../../src/main/services/calls/call-detector";

const inCall = [{ id: "zoom", input: true, output: true }];
const outputOnly = [{ id: "chrome", input: false, output: true }];

describe("CallDetector", () => {
  it("suggests only after input has lasted", () => {
    const detector = new CallDetector();
    detector.update(inCall, 0);
    expect(detector.suggestion(SUGGEST_AFTER_MS - 1)).toBeNull();
    expect(detector.suggestion(SUGGEST_AFTER_MS)).toBe("zoom");
  });

  it("never suggests for an app that only plays sound", () => {
    const detector = new CallDetector();
    detector.update(outputOnly, 0);
    detector.update(outputOnly, 60_000);
    expect(detector.suggestion(60_000)).toBeNull();
  });

  it("drops the suggestion when the microphone closes", () => {
    const detector = new CallDetector();
    detector.update(inCall, 0);
    detector.update([], SUGGEST_AFTER_MS);
    expect(detector.suggestion(SUGGEST_AFTER_MS)).toBeNull();
  });

  it("keeps a dismissal until that call ends, then offers the next call", () => {
    const detector = new CallDetector();
    detector.update(inCall, 0);
    detector.dismiss("zoom", 4_000);
    detector.update(inCall, 10_000);
    expect(detector.suggestion(10_000)).toBeNull();
    detector.update([], 11_000);
    detector.update([], 10_000 + CALL_END_AFTER_MS);
    detector.update(inCall, 50_000);
    detector.update(inCall, 50_000 + SUGGEST_AFTER_MS);
    expect(detector.suggestion(50_000 + SUGGEST_AFTER_MS)).toBe("zoom");
  });

  it("ends a call only after both directions stay closed", () => {
    const detector = new CallDetector();
    detector.update(inCall, 0);
    detector.update([], 1_000);
    expect(detector.hasEnded("zoom", CALL_END_AFTER_MS - 1)).toBe(false);
    expect(detector.hasEnded("zoom", CALL_END_AFTER_MS)).toBe(true);
  });

  it("ends a browser call once its microphone stays off, even while another tab plays", () => {
    const detector = new CallDetector();
    const playing = [{ id: "chrome", input: false, output: true }];
    detector.update([{ id: "chrome", input: true, output: true }], 0);
    detector.update(playing, 1_000);
    // The microphone was last heard at 0.
    detector.update(playing, BROWSER_CALL_END_AFTER_MS - 1);
    expect(detector.hasEnded("chrome", BROWSER_CALL_END_AFTER_MS - 1, true)).toBe(false);
    detector.update(playing, BROWSER_CALL_END_AFTER_MS);
    expect(detector.hasEnded("chrome", BROWSER_CALL_END_AFTER_MS, true)).toBe(true);
    expect(detector.hasEnded("chrome", BROWSER_CALL_END_AFTER_MS, false)).toBe(false);
  });

  it("treats a muted call, which keeps both open, as still running", () => {
    const detector = new CallDetector();
    detector.update(inCall, 0);
    detector.update(inCall, 10 * 60_000);
    expect(detector.hasEnded("zoom", 10 * 60_000 + CALL_END_AFTER_MS)).toBe(false);
  });
});
