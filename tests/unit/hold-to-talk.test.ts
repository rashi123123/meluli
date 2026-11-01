/* @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { HoldToTalk } from "@main/hold-to-talk";

function fixture(setupComplete = true) {
  const actions = { setupComplete: vi.fn(() => setupComplete), begin: vi.fn(), end: vi.fn(), test: vi.fn() };
  return { actions, hold: new HoldToTalk(actions) };
}

describe("hold to talk", () => {
  it("begins on press and ends on release", () => {
    const f = fixture();
    f.hold.press();
    expect(f.actions.begin).toHaveBeenCalledOnce();
    f.hold.release();
    expect(f.actions.end).toHaveBeenCalledOnce();
    expect(f.actions.test).not.toHaveBeenCalled();
  });

  it("only reports the key while setup is open, so no window comes up", () => {
    const f = fixture(false);
    f.hold.press(); f.hold.release();
    expect(f.actions.test.mock.calls).toEqual([[true], [false]]);
    expect(f.actions.begin).not.toHaveBeenCalled();
    expect(f.actions.end).not.toHaveBeenCalled();
  });

  it("keeps one meaning for the whole hold when setup finishes in the middle of it", () => {
    const f = fixture(false);
    f.hold.press();
    f.actions.setupComplete.mockReturnValue(true);
    f.hold.release();
    expect(f.actions.end).not.toHaveBeenCalled();
    expect(f.actions.test).toHaveBeenLastCalledWith(false);
  });

  it("ignores a repeated press and a release with no press", () => {
    const f = fixture();
    f.hold.release();
    expect(f.actions.end).not.toHaveBeenCalled();
    f.hold.press(); f.hold.press();
    expect(f.actions.begin).toHaveBeenCalledOnce();
  });
});
