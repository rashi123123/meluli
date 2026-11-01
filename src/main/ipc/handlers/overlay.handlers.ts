import { clipboard } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import { clipboardTextSchema, overlaySizeSchema } from "@shared/schemas";
import type { OverlaySize } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerOverlayHandlers(
  registry: IpcRegistry,
  dependencies: {
    onOpen: () => Promise<void>;
    onRetarget: () => Promise<void>;
    onReady: () => void;
    onHide: () => boolean | Promise<boolean>;
    onSetSize: (size: OverlaySize) => void;
    onSetHeldRecording: (reason: "failed" | "canceled" | null) => void;
    onInsertText: (text: string) => boolean | Promise<boolean>;
  }
): void {
  registry.register(IPC_CHANNELS.overlayOpen, () => dependencies.onOpen());
  registry.register(IPC_CHANNELS.overlayRetarget, () => dependencies.onRetarget());
  registry.register(IPC_CHANNELS.overlayReady, () => dependencies.onReady());
  registry.register(IPC_CHANNELS.overlayHide, () => dependencies.onHide());
  registry.register(IPC_CHANNELS.overlaySetSize, (size) => dependencies.onSetSize(overlaySizeSchema.parse(size)));
  registry.register(IPC_CHANNELS.overlaySetHeldRecording, (reason) =>
    dependencies.onSetHeldRecording(reason === "failed" || reason === "canceled" ? reason : null));
  registry.register(IPC_CHANNELS.textInsertIntoFocusedField, (input) => {
    const text =
      input &&
      typeof input === "object" &&
      "text" in input &&
      typeof input.text === "string"
        ? input.text
        : "";
    return dependencies.onInsertText(text);
  });
  // The renderer's clipboard API needs a permission this app denies, and a focused window.
  registry.register(IPC_CHANNELS.clipboardWriteText, (input) => clipboard.writeText(clipboardTextSchema.parse(input)));
}
