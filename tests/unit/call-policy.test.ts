import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { supportsCallCapture } from "@shared/call-apps";
import { canWindowRoleAccessChannel, INVOKE_CHANNEL_ACCESS, type InvokeChannelName } from "@main/ipc/policy";

describe("call window access", () => {
  it("reaches its own controls, state and settings, and nothing else", () => {
    const allowed = Object.keys(INVOKE_CHANNEL_ACCESS).filter((channel) => canWindowRoleAccessChannel("call", channel as InvokeChannelName));
    expect(allowed.sort()).toEqual([
      IPC_CHANNELS.appState, IPC_CHANNELS.settingsGet, IPC_CHANNELS.callAccept, IPC_CHANNELS.callDismiss, IPC_CHANNELS.callStop
    ].sort());
  });

  it("keeps recording controls away from the other windows", () => {
    expect(canWindowRoleAccessChannel("main", IPC_CHANNELS.callAccept)).toBe(false);
    expect(canWindowRoleAccessChannel("overlay", IPC_CHANNELS.callAccept)).toBe(false);
    expect(canWindowRoleAccessChannel("overlay", IPC_CHANNELS.callRetry)).toBe(false);
  });
});

describe("supportsCallCapture", () => {
  it("needs macOS 14.2", () => {
    expect(supportsCallCapture("13.7.1")).toBe(false);
    expect(supportsCallCapture("14.1.2")).toBe(false);
    expect(supportsCallCapture("14.2.0")).toBe(true);
    expect(supportsCallCapture("26.0.0")).toBe(true);
    expect(supportsCallCapture("")).toBe(false);
  });
});
