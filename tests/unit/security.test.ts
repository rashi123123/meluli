/* @vitest-environment node */

import type { IpcMainInvokeEvent, PermissionCheckHandlerHandlerDetails, WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { overlaySizeSchema } from "@shared/schemas";
import {
  assertSafeRecordingAudioPayload,
  assertValidIpcSender,
  createRendererSecurityEnvironment,
  isAllowedOpenExternalUrl,
  isTrustedRendererUrl,
  resolveDevServerUrl,
  shouldAllowPermissionCheck,
  shouldAllowPermissionRequest
} from "@main/security";

function createMockSender(url: string) {
  const senderFrame = { url } as Electron.WebFrameMain;
  const sender = {
    getURL: () => url,
    mainFrame: senderFrame
  } as unknown as WebContents;

  return { sender, senderFrame };
}

describe("renderer security environment", () => {
  it("ignores ELECTRON_RENDERER_URL in packaged builds", () => {
    expect(resolveDevServerUrl("http://localhost:5173", true)).toBeNull();
  });

  it("allows only loopback dev server URLs", () => {
    expect(resolveDevServerUrl("http://localhost:5173", false)?.origin).toBe("http://localhost:5173");
    expect(() => resolveDevServerUrl("https://example.com", false)).toThrow(/Rejected non-loopback/);
  });

  it("refuses a file URL that names a host", () => {
    const environment = createRendererSecurityEnvironment({ isPackaged: true });
    expect(isTrustedRendererUrl("file:///app/renderer/index.html?window=main", "main", environment)).toBe(true);
    expect(isTrustedRendererUrl("file://share.example/renderer/index.html?window=main", "main", environment)).toBe(false);
  });
});

describe("IPC sender validation", () => {
  const environment = createRendererSecurityEnvironment({
    isPackaged: true
  });

  it("rejects main window access to overlay-only channels", () => {
    const { sender, senderFrame } = createMockSender("file:///app/renderer/index.html?window=main");

    expect(() =>
      assertValidIpcSender(
        IPC_CHANNELS.overlayHide,
        {
          sender,
          senderFrame
        } as IpcMainInvokeEvent,
        {
          getWindowRoleForWebContents: () => "main"
        },
        environment
      )
    ).toThrow(/disallowed window role/);
  });

  it("lets only the overlay window report held audio", () => {
    const { sender, senderFrame } = createMockSender("file:///app/renderer/index.html?window=main");
    expect(() => assertValidIpcSender(
      IPC_CHANNELS.overlaySetHeldRecording,
      { sender, senderFrame } as IpcMainInvokeEvent,
      { getWindowRoleForWebContents: () => "main" },
      environment
    )).toThrow(/disallowed window role/);
  });

  it("lets only the overlay window resize itself, to a known size", () => {
    const { sender, senderFrame } = createMockSender("file:///app/renderer/index.html?window=main");
    expect(() => assertValidIpcSender(
      IPC_CHANNELS.overlaySetSize,
      { sender, senderFrame } as IpcMainInvokeEvent,
      { getWindowRoleForWebContents: () => "main" },
      environment
    )).toThrow(/disallowed window role/);
    expect(overlaySizeSchema.safeParse("expanded").success).toBe(true);
    expect(overlaySizeSchema.safeParse({ width: 4000, height: 4000 }).success).toBe(false);
  });

  it("lets only the overlay window retarget a resent recording", () => {
    const { sender, senderFrame } = createMockSender("file:///app/renderer/index.html?window=main");
    expect(() => assertValidIpcSender(
      IPC_CHANNELS.overlayRetarget,
      { sender, senderFrame } as IpcMainInvokeEvent,
      { getWindowRoleForWebContents: () => "main" },
      environment
    )).toThrow(/disallowed window role/);
  });

  it("rejects overlay window access to main-only channels", () => {
    const { sender, senderFrame } = createMockSender("file:///app/renderer/index.html?window=overlay");

    expect(() =>
      assertValidIpcSender(
        IPC_CHANNELS.settingsSet,
        {
          sender,
          senderFrame
        } as IpcMainInvokeEvent,
        {
          getWindowRoleForWebContents: () => "overlay"
        },
        environment
      )
    ).toThrow(/disallowed window role/);
  });

  it("rejects untrusted renderer URLs even when the role matches", () => {
    const { sender, senderFrame } = createMockSender("https://example.com/?window=main");

    expect(() =>
      assertValidIpcSender(
        IPC_CHANNELS.settingsGet,
        {
          sender,
          senderFrame
        } as IpcMainInvokeEvent,
        {
          getWindowRoleForWebContents: () => "main"
        },
        environment
      )
    ).toThrow(/untrusted renderer URL/);
  });
});

describe("recording audio payload", () => {
  const audioPayload = (samples: number[]) => ({
    sampleRate: 16_000,
    durationMs: 1_000,
    pcm: new Float32Array(samples).buffer
  });

  it("accepts resampling overshoot past full scale", () => {
    expect(() => assertSafeRecordingAudioPayload(audioPayload([0, 1.0007, -1.0007]))).not.toThrow();
  });

  it("rejects non-finite samples", () => {
    expect(() => assertSafeRecordingAudioPayload(audioPayload([0, Number.NaN]))).toThrow(/non-finite/);
    expect(() => assertSafeRecordingAudioPayload(audioPayload([Number.POSITIVE_INFINITY]))).toThrow(/non-finite/);
  });
});

describe("permission hardening", () => {
  const environment = createRendererSecurityEnvironment({
    isPackaged: false,
    rawDevServerUrl: "http://localhost:5173"
  });

  it("allows microphone checks only for trusted origins", () => {
    const sender = {
      getURL: () => "http://localhost:5173/?window=main"
    } as unknown as WebContents;

    expect(
      shouldAllowPermissionCheck(
        sender,
        "media",
        "http://localhost:5173",
        {
          mediaType: "audio",
          requestingUrl: "http://localhost:5173/?window=main",
          embeddingOrigin: "http://localhost:5173",
          isMainFrame: true,
          securityOrigin: "http://localhost:5173"
        } as PermissionCheckHandlerHandlerDetails,
        {
          getWindowRoleForWebContents: () => "main"
        },
        environment
      )
    ).toBe(true);
  });

  it("rejects microphone checks when embeddingOrigin is unexpected", () => {
    const sender = {
      getURL: () => "http://localhost:5173/?window=overlay"
    } as unknown as WebContents;

    expect(
      shouldAllowPermissionCheck(
        sender,
        "media",
        "http://localhost:5173",
        {
          mediaType: "audio",
          requestingUrl: "http://localhost:5173/?window=overlay",
          embeddingOrigin: "https://example.com",
          isMainFrame: true,
          securityOrigin: "http://localhost:5173"
        } as PermissionCheckHandlerHandlerDetails,
        {
          getWindowRoleForWebContents: () => "overlay"
        },
        environment
      )
    ).toBe(false);
  });

  it("rejects microphone requests when the security origin is unexpected", () => {
    const sender = {
      getURL: () => "http://localhost:5173/?window=main"
    } as unknown as WebContents;

    expect(
      shouldAllowPermissionRequest(
        sender,
        "media",
        {
          isMainFrame: true,
          requestingUrl: "http://localhost:5173/?window=main",
          securityOrigin: "https://example.com",
          mediaTypes: ["audio"]
        },
        {
          getWindowRoleForWebContents: () => "main"
        },
        environment
      )
    ).toBe(false);
  });
});

describe("external URL policy", () => {
  it("allows only https URLs for generic shell.openExternal", () => {
    expect(isAllowedOpenExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedOpenExternalUrl("http://example.com")).toBe(false);
    expect(isAllowedOpenExternalUrl("file:///tmp/test.txt")).toBe(false);
    expect(isAllowedOpenExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
