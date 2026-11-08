import { useMemo, useState, type ReactNode } from "react";
import { AppContext, type AppContextValue, type RecordingContextValue } from "@/context/app-context";
import { OverlayContext } from "@/context/overlay-context";
import { appSettingsSchema } from "@shared/schemas";
import { deriveOnboardingDisplayState } from "@shared/onboarding";
import type {
  AccessibilityPermissionStatus, AppSettings, AppStateSnapshot, MainView, MicrophonePermissionStatus,
  ModelDownloadProgress, OnboardingPhase, TranscriptRecord
} from "@shared/types";
import { logLabCall } from "./mock-bridge";

const MINUTE = 60_000;
const now = Date.now();

export const transcripts: TranscriptRecord[] = [
  { id: "t-mic", sourceType: "microphone", createdAt: now - 4 * MINUTE, durationMs: 18_000,
    text: "תזכורת לעצמי: לשלוח לדנה את הסיכום של הפגישה עד יום חמישי, ולבדוק אם המצגת מוכנה." },
  { id: "t-long", sourceType: "microphone", createdAt: now - 90 * MINUTE, durationMs: 142_000,
    text: "בפגישה של היום עברנו על תוכנית הרבעון. הוחלט להקדים את ההשקה בשבועיים, בתנאי שבדיקות האיכות יסתיימו בזמן.\n\nצוות העיצוב יציג גרסה חדשה של מסך ההרשמה ביום ראשון. נשאר לסגור את נושא התמחור, ויוסי ירכז את ההערות מכולם.\n\nבסוף דיברנו על גיוס: שתי משרות פתוחות בצוות הפיתוח, ואחת בתמיכה.",
    paragraphs: [
      "בפגישה של היום עברנו על תוכנית הרבעון. הוחלט להקדים את ההשקה בשבועיים, בתנאי שבדיקות האיכות יסתיימו בזמן.",
      "צוות העיצוב יציג גרסה חדשה של מסך ההרשמה ביום ראשון. נשאר לסגור את נושא התמחור, ויוסי ירכז את ההערות מכולם.",
      "בסוף דיברנו על גיוס: שתי משרות פתוחות בצוות הפיתוח, ואחת בתמיכה."
    ] },
  { id: "t-file", sourceType: "imported_file", createdAt: now - 26 * 60 * MINUTE, durationMs: 610_000, importedFileName: "ראיון-עם-מרים.m4a",
    text: "אז איך התחלת בכלל לעבוד בתחום? האמת שזה קרה במקרה. חברה ביקשה עזרה בפרויקט קטן, ומשם זה פשוט התגלגל." },
  { id: "t-youtube", sourceType: "youtube", createdAt: now - 3 * 24 * 60 * MINUTE, durationMs: 1_260_000,
    sourceTitle: "הרצאה: איך עובד זיהוי דיבור", sourceUrl: "https://www.youtube.com/watch?v=lab",
    text: "מודל זיהוי דיבור מקבל אות שמע, מפרק אותו לחלונות קצרים, ומנבא את הטקסט המתאים לכל קטע.",
    segments: [
      { start: 0, end: 4.2, text: "מודל זיהוי דיבור מקבל אות שמע," },
      { start: 4.2, end: 8.6, text: "מפרק אותו לחלונות קצרים," },
      { start: 8.6, end: 12.9, text: "ומנבא את הטקסט המתאים לכל קטע." }
    ] },
  { id: "t-call", sourceType: "call", createdAt: now - 6 * 24 * 60 * MINUTE, durationMs: 1_840_000,
    text: "שלום, שומעים אותי? כן, מצוין. אז נתחיל מהעדכונים של השבוע.",
    segments: [
      { start: 0, end: 2.1, text: "שלום, שומעים אותי?", speaker: "me" },
      { start: 2.1, end: 3.4, text: "כן, מצוין.", speaker: "others" },
      { start: 3.4, end: 6.8, text: "אז נתחיל מהעדכונים של השבוע.", speaker: "me" }
    ] }
];

export interface LabSeed {
  settings?: (settings: AppSettings) => void;
  appState?: Partial<AppStateSnapshot>;
  permissionStatus?: MicrophonePermissionStatus;
  accessibilityPermissionStatus?: AccessibilityPermissionStatus;
  modelProgress?: ModelDownloadProgress | null;
  transcripts?: TranscriptRecord[];
  lastTranscript?: TranscriptRecord | null;
  activeView?: MainView;
  errorMessage?: string | null;
  loading?: boolean;
  loadFailed?: boolean;
  recording?: Partial<RecordingContextValue>;
}

export function makeSettings(edit?: (settings: AppSettings) => void): AppSettings {
  const settings = appSettingsSchema.parse({
    onboardingCompleted: true,
    onboarding: { phase: "activated", surface: "workspace", activatedAt: now - 7 * 24 * 60 * MINUTE, completedOptionalActions: ["recording_shortcut", "overlay_accessibility"], dismissedOptionalActions: [] },
    dictionary: [
      { id: "d1", heard: "ריאקט", written: "React" },
      { id: "d2", heard: "מלולי", written: "Meluli" },
      { id: "d3", heard: "גיטהאב", written: "GitHub" }
    ]
  });
  settings.modelState.downloadState = "ready";
  settings.modelState.totalBytes = 1_620_000_000;
  settings.modelState.bytesDownloaded = 1_620_000_000;
  edit?.(settings);
  return settings;
}

/** Onboarding at a given phase, before the model is installed unless the phase is past it. */
export function onboardingAt(phase: OnboardingPhase, surface: "flow" | "workspace" = "flow") {
  return (settings: AppSettings) => {
    settings.onboardingCompleted = false;
    settings.onboarding = { phase, surface, activatedAt: null, completedOptionalActions: [], dismissedOptionalActions: [] };
    if (phase !== "needs_first_transcript" && phase !== "activated") settings.modelState.downloadState = "missing";
  };
}

const action = (name: string, result?: unknown) => (...args: unknown[]) => {
  logLabCall(`context.${name}`, args);
  return Promise.resolve(result) as Promise<never>;
};

function recording(overrides: Partial<RecordingContextValue> = {}): RecordingContextValue {
  return {
    livePreview: null, isPreparing: false, isResending: false, mediaStream: null, heldRecording: null,
    startRecording: action("recording.startRecording"), pauseRecording: action("recording.pauseRecording"),
    resumeRecording: action("recording.resumeRecording"), stopRecording: action("recording.stopRecording"),
    abandonStart: action("recording.abandonStart", false),
    beginHold: () => { logLabCall("context.recording.beginHold"); return false; },
    heldRecordingSaved: () => false,
    endHold: () => logLabCall("context.recording.endHold"),
    cancelRecording: action("recording.cancelRecording", false), resendHeldRecording: action("recording.resendHeldRecording"),
    cancelProcessing: action("recording.cancelProcessing", { canceled: true, held: false }),
    interruptRecording: action("recording.interruptRecording"),
    dropHeldRecording: () => logLabCall("context.recording.dropHeldRecording"),
    ...overrides
  };
}

/** Context with local state, so navigation, search, settings and dictionary edits respond. */
export function LabProvider({ seed = {}, children }: { seed?: LabSeed; children: ReactNode }) {
  const [settings, setSettings] = useState(() => makeSettings(seed.settings));
  const [activeView, setActiveView] = useState<MainView>(seed.activeView ?? "workspace");
  const [errorMessage, setErrorMessage] = useState<string | null>(seed.errorMessage ?? null);
  const [items, setItems] = useState(seed.transcripts ?? transcripts);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);

  const value = useMemo<AppContextValue>(() => {
    const permissionStatus = seed.permissionStatus ?? "granted";
    const query = searchQuery.trim();
    const visible = query ? items.filter(item => item.text.includes(query) || item.importedFileName?.includes(query) || item.sourceTitle?.includes(query)) : items;
    const selectedTranscript = visible.find(item => item.id === selectedId) ?? null;
    const lastTranscript = seed.lastTranscript === undefined ? items[0] ?? null : seed.lastTranscript;
    return {
      loading: seed.loading ?? false,
      loadFailed: seed.loadFailed ?? false,
      settings,
      appState: { status: "idle", timerStartedAt: null, holdKey: { status: "ready" }, update: { status: "idle", version: null }, linkImportAvailable: true, ...seed.appState },
      permissionStatus,
      accessibilityPermissionStatus: seed.accessibilityPermissionStatus ?? "granted",
      modelProgress: seed.modelProgress ?? null,
      lastTranscript,
      onboarding: deriveOnboardingDisplayState(settings, permissionStatus),
      activeView,
      setActiveView: (view) => { logLabCall("context.setActiveView", [view]); setActiveView(view); },
      errorMessage,
      setErrorMessage,
      transcripts: {
        latestTranscript: lastTranscript, items: visible, selectedId, selectedTranscript, searchQuery, setSearchQuery,
        setSelectedId: (id) => setSelectedId(id),
        prependTranscript: (transcript) => setItems(current => [transcript, ...current]),
        updateTranscript: async (id, edit) => {
          logLabCall("context.transcripts.updateTranscript", [id]);
          const text = "text" in edit ? edit.text : edit.cueTexts.join(" ");
          let next: TranscriptRecord | null = null;
          setItems(current => current.map(item => item.id === id ? (next = { ...item, text, editedAt: Date.now() }) : item));
          return next;
        },
        restoreTranscript: action("transcripts.restoreTranscript", null),
        deleteTranscript: async (id) => { logLabCall("context.transcripts.deleteTranscript", [id]); setItems(current => current.filter(item => item.id !== id)); return true; },
        deleteAllTranscripts: async () => { logLabCall("context.transcripts.deleteAllTranscripts"); setItems([]); },
        loadMore: action("transcripts.loadMore"), refresh: action("transcripts.refresh"), replaceTranscript: action("transcripts.replaceTranscript"), hasMore: false, isLoading: false
      },
      recording: recording(seed.recording),
      updateSetting: async (key, next) => {
        logLabCall("context.updateSetting", [key, next]);
        setSettings(current => ({ ...current, [key]: next }));
      },
      requestMicrophonePermission: action("requestMicrophonePermission", "granted"),
      requestAccessibilityPermission: action("requestAccessibilityPermission", "granted"),
      downloadModel: action("downloadModel"), importAudio: action("importAudio"),
      importDroppedAudio: action("importDroppedAudio"), submitYouTubeUrl: action("submitYouTubeUrl"),
      cancelActiveYouTube: action("cancelActiveYouTube"), cancelPendingYouTube: action("cancelPendingYouTube"),
      revealStorage: action("revealStorage"), rerunOnboarding: action("rerunOnboarding"), resetEverything: action("resetEverything"),
      trackOnboardingStepViewed: action("trackOnboardingStepViewed"), completeOnboardingStep: action("completeOnboardingStep"),
      continueOnboardingLater: action("continueOnboardingLater"), goBackOnboardingStep: action("goBackOnboardingStep"),
      resumeOnboardingFlow: action("resumeOnboardingFlow"), dismissOnboardingOptionalAction: action("dismissOnboardingOptionalAction")
    };
    // The seed is fixed for a story's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, activeView, errorMessage, items, searchQuery, selectedId]);

  return <AppContext.Provider value={value}><OverlayContext.Provider value={value}>{children}</OverlayContext.Provider></AppContext.Provider>;
}
