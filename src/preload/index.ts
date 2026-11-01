import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { IvritMenuBarApi } from "@shared/preload-api";

type WindowMode = "main" | "overlay" | "call";
type SharedApi = {
  recording: IvritMenuBarApi["recording"];
  transcription: Pick<IvritMenuBarApi["transcription"], "cancel" | "onFailed">;
  clipboard: IvritMenuBarApi["clipboard"];
  settings: Pick<IvritMenuBarApi["settings"], "get" | "onChanged">;
  permissions: Pick<
    IvritMenuBarApi["permissions"],
    "microphoneStatus" | "requestMicrophone" | "accessibilityStatus" | "requestAccessibility"
  >;
  app: Pick<IvritMenuBarApi["app"], "state" | "isMockMode" | "onState">;
};

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

function resolveWindowMode(): WindowMode {
  const browserGlobal = globalThis as typeof globalThis & {
    location?: {
      search?: string;
    };
  };
  const value = new URLSearchParams(browserGlobal.location?.search ?? "").get("window");
  return value === "overlay" || value === "call" ? value : "main";
}

function createSharedApi(): SharedApi {
  return {
    recording: {
      experimentalEnabled: () => ipcRenderer.invoke(IPC_CHANNELS.dictationEnabled),
      experimentalBegin: () => ipcRenderer.invoke(IPC_CHANNELS.dictationBegin),
      experimentalChunk: (input) => ipcRenderer.invoke(IPC_CHANNELS.dictationChunk, input),
      onExperimentalPreview: (listener) => subscribe(IPC_CHANNELS.dictationPreview, listener),
      start: (startedAt) => ipcRenderer.invoke(IPC_CHANNELS.recordingStart, { startedAt }),
      pause: (elapsedMs) => ipcRenderer.invoke(IPC_CHANNELS.recordingPause, { elapsedMs }),
      stop: () => ipcRenderer.invoke(IPC_CHANNELS.recordingStop),
      sendAudio: (payload) => ipcRenderer.invoke(IPC_CHANNELS.recordingSendAudio, payload)
    },
    transcription: {
      cancel: () => ipcRenderer.invoke(IPC_CHANNELS.transcriptionCancel),
      onFailed: (listener) => subscribe(IPC_CHANNELS.transcriptionFailed, listener)
    },
    clipboard: {
      writeText: (text) => ipcRenderer.invoke(IPC_CHANNELS.clipboardWriteText, text)
    },
    settings: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
      onChanged: (listener) => subscribe(IPC_CHANNELS.settingsChanged, listener)
    },
    permissions: {
      microphoneStatus: () => ipcRenderer.invoke(IPC_CHANNELS.permissionMicrophoneStatus),
      requestMicrophone: () => ipcRenderer.invoke(IPC_CHANNELS.permissionRequestMicrophone),
      accessibilityStatus: () => ipcRenderer.invoke(IPC_CHANNELS.permissionAccessibilityStatus),
      requestAccessibility: () => ipcRenderer.invoke(IPC_CHANNELS.permissionRequestAccessibility)
    },
    app: {
      state: () => ipcRenderer.invoke(IPC_CHANNELS.appState),
      isMockMode: () => ipcRenderer.invoke(IPC_CHANNELS.appIsMockMode),
      onState: (listener) => subscribe(IPC_CHANNELS.appState, listener)
    }
  };
}

function createMainApi(shared: ReturnType<typeof createSharedApi>): IvritMenuBarApi {
  return {
    ...shared,
    history: {
      list: (limit = 20, cursor = null) => ipcRenderer.invoke(IPC_CHANNELS.historyList, { limit, cursor }),
      search: (query, limit = 20, cursor = null) =>
        ipcRenderer.invoke(IPC_CHANNELS.historySearch, { query, limit, cursor }),
      get: (id) => ipcRenderer.invoke(IPC_CHANNELS.historyGet, id),
      update: (input) => ipcRenderer.invoke(IPC_CHANNELS.historyUpdate, input),
      restoreOriginal: (id) => ipcRenderer.invoke(IPC_CHANNELS.historyRestoreOriginal, { id }),
      delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.historyDelete, { id }),
      deleteAll: () => ipcRenderer.invoke(IPC_CHANNELS.historyDeleteAll)
    },
    model: {
      status: () => ipcRenderer.invoke(IPC_CHANNELS.modelStatus),
      download: () => ipcRenderer.invoke(IPC_CHANNELS.modelDownload),
      remove: () => ipcRenderer.invoke(IPC_CHANNELS.modelRemove),
      onProgress: (listener) => subscribe(IPC_CHANNELS.modelDownloadProgress, listener)
    },
    files: {
      importAudio: () => ipcRenderer.invoke(IPC_CHANNELS.fileImportAudio),
      // The path comes from the dropped File itself, so a page cannot name one.
      importDroppedAudio: (file) => ipcRenderer.invoke(IPC_CHANNELS.fileImportDroppedAudio, webUtils.getPathForFile(file)),
      exportTranscriptSrt: (id) => ipcRenderer.invoke(IPC_CHANNELS.fileExportTranscriptSrt, { id }),
      revealPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.fileRevealPath, path),
      openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.fileOpenExternal, url),
      storagePaths: () => ipcRenderer.invoke(IPC_CHANNELS.fileStoragePaths)
    },
    youtube: {
      submit: (input) => ipcRenderer.invoke(IPC_CHANNELS.youtubeSubmit, input),
      cancelActive: () => ipcRenderer.invoke(IPC_CHANNELS.youtubeCancelActive),
      cancelPending: () => ipcRenderer.invoke(IPC_CHANNELS.youtubeCancelPending)
    },
    shortcut: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.shortcutGet),
      set: (accelerator) => ipcRenderer.invoke(IPC_CHANNELS.shortcutSet, accelerator)
    },
    settings: {
      ...shared.settings,
      set: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, { key, value })
    },
    transcription: {
      ...shared.transcription,
      onProgress: (listener) => subscribe(IPC_CHANNELS.transcriptionProgress, listener),
      onComplete: (listener) => subscribe(IPC_CHANNELS.transcriptionComplete, listener)
    },
    permissions: {
      ...shared.permissions,
      openMicrophoneSettings: () => ipcRenderer.invoke(IPC_CHANNELS.permissionOpenMicrophoneSettings),
      openAccessibilitySettings: () => ipcRenderer.invoke(IPC_CHANNELS.permissionOpenAccessibilitySettings),
      requestHoldKey: () => ipcRenderer.invoke(IPC_CHANNELS.permissionRequestHoldKey),
      openHoldKeySettings: () => ipcRenderer.invoke(IPC_CHANNELS.permissionOpenHoldKeySettings)
    },
    app: {
      ...shared.app,
      version: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
      installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.appInstallUpdate),
      openLicenses: () => ipcRenderer.invoke(IPC_CHANNELS.appOpenLicenses),
      onNavigate: (listener) => subscribe(IPC_CHANNELS.appNavigateRequested, listener),
      onHoldKeyPressed: (listener) => subscribe(IPC_CHANNELS.holdKeyPressed, listener)
    },
    overlay: { open: () => ipcRenderer.invoke(IPC_CHANNELS.overlayOpen) },
    call: {
      retry: (id) => ipcRenderer.invoke(IPC_CHANNELS.callRetry, id),
      discard: (id) => ipcRenderer.invoke(IPC_CHANNELS.callDiscard, id),
      dismissNotice: () => ipcRenderer.invoke(IPC_CHANNELS.callDismissNotice),
      openAudioSettings: () => ipcRenderer.invoke(IPC_CHANNELS.callOpenAudioSettings)
    },
    textInsert: {}
  } as IvritMenuBarApi;
}

function createOverlayApi(shared: ReturnType<typeof createSharedApi>): IvritMenuBarApi {
  return {
    ...shared,
    overlay: {
      ready: () => ipcRenderer.invoke(IPC_CHANNELS.overlayReady),
      retarget: () => ipcRenderer.invoke(IPC_CHANNELS.overlayRetarget),
      hide: () => ipcRenderer.invoke(IPC_CHANNELS.overlayHide),
      setSize: (size) => ipcRenderer.invoke(IPC_CHANNELS.overlaySetSize, size),
      setHeldRecording: (reason) => ipcRenderer.invoke(IPC_CHANNELS.overlaySetHeldRecording, reason),
      onSnapPreview: (listener) => subscribe(IPC_CHANNELS.overlaySnapPreview, listener)
    },
    textInsert: {
      intoFocusedField: (text) => ipcRenderer.invoke(IPC_CHANNELS.textInsertIntoFocusedField, { text })
    },
    app: {
      ...shared.app,
      showMain: (view) => ipcRenderer.invoke(IPC_CHANNELS.appShowMain, view),
      onRecordingToggleRequested: (listener) =>
        subscribe(IPC_CHANNELS.recordingToggleRequested, () => listener()),
      onRecordingHoldRequested: (listener) => subscribe(IPC_CHANNELS.recordingHoldRequested, listener),
      onRecordingCancelRequested: (listener) =>
        subscribe(IPC_CHANNELS.recordingCancelRequested, () => listener()),
      onRecordingUndoRequested: (listener) =>
        subscribe(IPC_CHANNELS.recordingUndoRequested, () => listener()),
      onRecordingInterruptRequested: (listener) =>
        subscribe(IPC_CHANNELS.recordingInterruptRequested, () => listener())
    }
  } as IvritMenuBarApi;
}

/** This window can start a recording, so it gets nothing else. */
function createCallApi(): IvritMenuBarApi {
  return {
    settings: {
      get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
      onChanged: (listener) => subscribe(IPC_CHANNELS.settingsChanged, listener)
    },
    app: {
      state: () => ipcRenderer.invoke(IPC_CHANNELS.appState),
      onState: (listener) => subscribe(IPC_CHANNELS.appState, listener)
    },
    call: {
      accept: () => ipcRenderer.invoke(IPC_CHANNELS.callAccept),
      dismiss: () => ipcRenderer.invoke(IPC_CHANNELS.callDismiss),
      stop: () => ipcRenderer.invoke(IPC_CHANNELS.callStop)
    }
  } as IvritMenuBarApi;
}

const sharedApi = createSharedApi();
const windowMode = resolveWindowMode();
const api = windowMode === "overlay" ? createOverlayApi(sharedApi)
  : windowMode === "call" ? createCallApi()
  : createMainApi(sharedApi);

contextBridge.exposeInMainWorld("ivritMenuBar", api);
