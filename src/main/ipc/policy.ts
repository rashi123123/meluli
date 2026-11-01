import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { AppWindowRole } from "../runtime";

export type InvokeChannelName =
  | typeof IPC_CHANNELS.recordingStart
  | typeof IPC_CHANNELS.recordingPause
  | typeof IPC_CHANNELS.recordingStop
  | typeof IPC_CHANNELS.recordingSendAudio
  | typeof IPC_CHANNELS.dictationBegin
  | typeof IPC_CHANNELS.dictationEnabled
  | typeof IPC_CHANNELS.dictationChunk
  | typeof IPC_CHANNELS.transcriptionCancel
  | typeof IPC_CHANNELS.modelStatus
  | typeof IPC_CHANNELS.modelDownload
  | typeof IPC_CHANNELS.modelRemove
  | typeof IPC_CHANNELS.historyList
  | typeof IPC_CHANNELS.historyGet
  | typeof IPC_CHANNELS.historySearch
  | typeof IPC_CHANNELS.historyUpdate
  | typeof IPC_CHANNELS.historyRestoreOriginal
  | typeof IPC_CHANNELS.historyDelete
  | typeof IPC_CHANNELS.historyDeleteAll
  | typeof IPC_CHANNELS.settingsGet
  | typeof IPC_CHANNELS.settingsSet
  | typeof IPC_CHANNELS.fileImportAudio
  | typeof IPC_CHANNELS.fileImportDroppedAudio
  | typeof IPC_CHANNELS.fileExportTranscriptSrt
  | typeof IPC_CHANNELS.fileRevealPath
  | typeof IPC_CHANNELS.fileOpenExternal
  | typeof IPC_CHANNELS.fileStoragePaths
  | typeof IPC_CHANNELS.youtubeSubmit
  | typeof IPC_CHANNELS.youtubeCancelActive
  | typeof IPC_CHANNELS.youtubeCancelPending
  | typeof IPC_CHANNELS.permissionMicrophoneStatus
  | typeof IPC_CHANNELS.permissionRequestMicrophone
  | typeof IPC_CHANNELS.permissionOpenMicrophoneSettings
  | typeof IPC_CHANNELS.permissionAccessibilityStatus
  | typeof IPC_CHANNELS.permissionRequestAccessibility
  | typeof IPC_CHANNELS.permissionOpenAccessibilitySettings
  | typeof IPC_CHANNELS.permissionRequestHoldKey
  | typeof IPC_CHANNELS.permissionOpenHoldKeySettings
  | typeof IPC_CHANNELS.shortcutGet
  | typeof IPC_CHANNELS.shortcutSet
  | typeof IPC_CHANNELS.appState
  | typeof IPC_CHANNELS.appIsMockMode
  | typeof IPC_CHANNELS.appVersion
  | typeof IPC_CHANNELS.appInstallUpdate
  | typeof IPC_CHANNELS.appOpenLicenses
  | typeof IPC_CHANNELS.appShowMain
  | typeof IPC_CHANNELS.overlayOpen
  | typeof IPC_CHANNELS.overlayRetarget
  | typeof IPC_CHANNELS.overlayReady
  | typeof IPC_CHANNELS.callAccept
  | typeof IPC_CHANNELS.callDismiss
  | typeof IPC_CHANNELS.callStop
  | typeof IPC_CHANNELS.callRetry
  | typeof IPC_CHANNELS.callDiscard
  | typeof IPC_CHANNELS.callDismissNotice
  | typeof IPC_CHANNELS.callOpenAudioSettings
  | typeof IPC_CHANNELS.overlayHide
  | typeof IPC_CHANNELS.overlaySetSize
  | typeof IPC_CHANNELS.overlaySetHeldRecording
  | typeof IPC_CHANNELS.textInsertIntoFocusedField
  | typeof IPC_CHANNELS.clipboardWriteText;

export type InvokeChannelAccess = "main-only" | "overlay-only" | "call-only" | "shared";

export const INVOKE_CHANNEL_ACCESS: Readonly<Record<InvokeChannelName, InvokeChannelAccess>> = {
  [IPC_CHANNELS.recordingStart]: "shared",
  [IPC_CHANNELS.recordingPause]: "shared",
  [IPC_CHANNELS.recordingStop]: "shared",
  [IPC_CHANNELS.recordingSendAudio]: "shared",
  [IPC_CHANNELS.dictationBegin]: "shared",
  [IPC_CHANNELS.dictationEnabled]: "shared",
  [IPC_CHANNELS.dictationChunk]: "shared",
  [IPC_CHANNELS.transcriptionCancel]: "shared",
  [IPC_CHANNELS.modelStatus]: "main-only",
  [IPC_CHANNELS.modelDownload]: "main-only",
  [IPC_CHANNELS.modelRemove]: "main-only",
  [IPC_CHANNELS.historyList]: "main-only",
  [IPC_CHANNELS.historyGet]: "main-only",
  [IPC_CHANNELS.historySearch]: "main-only",
  [IPC_CHANNELS.historyUpdate]: "main-only",
  [IPC_CHANNELS.historyRestoreOriginal]: "main-only",
  [IPC_CHANNELS.historyDelete]: "main-only",
  [IPC_CHANNELS.historyDeleteAll]: "main-only",
  [IPC_CHANNELS.settingsGet]: "shared",
  [IPC_CHANNELS.settingsSet]: "main-only",
  [IPC_CHANNELS.fileImportAudio]: "main-only",
  [IPC_CHANNELS.fileImportDroppedAudio]: "main-only",
  [IPC_CHANNELS.fileExportTranscriptSrt]: "main-only",
  [IPC_CHANNELS.fileRevealPath]: "main-only",
  [IPC_CHANNELS.fileOpenExternal]: "main-only",
  [IPC_CHANNELS.fileStoragePaths]: "main-only",
  [IPC_CHANNELS.youtubeSubmit]: "main-only",
  [IPC_CHANNELS.youtubeCancelActive]: "main-only",
  [IPC_CHANNELS.youtubeCancelPending]: "main-only",
  [IPC_CHANNELS.permissionMicrophoneStatus]: "shared",
  [IPC_CHANNELS.permissionRequestMicrophone]: "shared",
  [IPC_CHANNELS.permissionOpenMicrophoneSettings]: "main-only",
  [IPC_CHANNELS.permissionAccessibilityStatus]: "shared",
  [IPC_CHANNELS.permissionRequestAccessibility]: "shared",
  [IPC_CHANNELS.permissionOpenAccessibilitySettings]: "main-only",
  [IPC_CHANNELS.permissionRequestHoldKey]: "main-only",
  [IPC_CHANNELS.permissionOpenHoldKeySettings]: "main-only",
  [IPC_CHANNELS.shortcutGet]: "main-only",
  [IPC_CHANNELS.shortcutSet]: "main-only",
  [IPC_CHANNELS.appState]: "shared",
  [IPC_CHANNELS.appIsMockMode]: "shared",
  [IPC_CHANNELS.appVersion]: "main-only",
  [IPC_CHANNELS.appInstallUpdate]: "main-only",
  [IPC_CHANNELS.appOpenLicenses]: "main-only",
  [IPC_CHANNELS.appShowMain]: "overlay-only",
  [IPC_CHANNELS.overlayOpen]: "main-only",
  [IPC_CHANNELS.overlayRetarget]: "overlay-only",
  [IPC_CHANNELS.overlayReady]: "overlay-only",
  [IPC_CHANNELS.callAccept]: "call-only",
  [IPC_CHANNELS.callDismiss]: "call-only",
  [IPC_CHANNELS.callStop]: "call-only",
  [IPC_CHANNELS.callRetry]: "main-only",
  [IPC_CHANNELS.callDiscard]: "main-only",
  [IPC_CHANNELS.callDismissNotice]: "main-only",
  [IPC_CHANNELS.callOpenAudioSettings]: "main-only",
  [IPC_CHANNELS.overlayHide]: "overlay-only",
  [IPC_CHANNELS.overlaySetSize]: "overlay-only",
  [IPC_CHANNELS.overlaySetHeldRecording]: "overlay-only",
  [IPC_CHANNELS.textInsertIntoFocusedField]: "overlay-only",
  [IPC_CHANNELS.clipboardWriteText]: "shared"
} as const;

export function canWindowRoleAccessChannel(role: AppWindowRole, channel: InvokeChannelName): boolean {
  const access = INVOKE_CHANNEL_ACCESS[channel];
  if (!access) {
    return false;
  }

  if (role === "call") {
    return access === "call-only" || channel === IPC_CHANNELS.appState || channel === IPC_CHANNELS.settingsGet;
  }

  if (access === "shared") {
    return true;
  }

  if (access === "main-only") {
    return role === "main";
  }

  return access === "overlay-only" && role === "overlay";
}
