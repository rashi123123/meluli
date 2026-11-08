import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import * as Icons from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { BarVisualizer, type AgentState } from "@/components/ui/bar-visualizer";
import { RecordButton } from "@/components/RecordButton";
import { CopyButton } from "@/components/CopyButton";
import { SearchInput } from "@/components/SearchInput";
import { ShortcutEditor } from "@/components/ShortcutEditor";
import { NoticeToast } from "@/components/NoticeToast";
import { LoadingMark } from "@/components/LoadingMark";
import { EmptyMark } from "@/components/EmptyMark";
import { RecordingArea } from "@/features/workspace/RecordingArea";
import { FileDropCell } from "@/features/workspace/FileDropCell";
import { YouTubeInputRow } from "@/features/workspace/YouTubeInputRow";
import { SupportedSitesInfo } from "@/features/workspace/SupportedSitesInfo";
import { RecentTranscripts } from "@/features/workspace/RecentTranscripts";
import { CallStatus } from "@/features/workspace/CallStatus";
import { WorkspaceView } from "@/features/workspace/WorkspaceView";
import { TranscriptDocument } from "@/features/transcript/TranscriptDocument";
import { TranscriptEditor } from "@/features/transcript/TranscriptEditor";
import { HistoryList } from "@/features/history/HistoryList";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { DictionarySection } from "@/features/dictionary/DictionarySection";
import { DictionaryView } from "@/features/dictionary/DictionaryView";
import { SettingsRow } from "@/features/settings/SettingsRow";
import { ThemePicker } from "@/features/settings/ThemePicker";
import { OverlayPositionPicker } from "@/features/settings/OverlayPositionPicker";
import { SettingsView } from "@/features/settings/SettingsView";
import { InfoPage } from "@/features/info/InfoPage";
import { OnboardingStepShell } from "@/features/onboarding/OnboardingStepShell";
import { WelcomeStep } from "@/features/onboarding/WelcomeStep";
import { MicrophoneStep } from "@/features/onboarding/MicrophoneStep";
import { ModelDownloadStep } from "@/features/onboarding/ModelDownloadStep";
import { OnboardingBottomBar } from "@/features/onboarding/OnboardingBottomBar";
import { SpeechDemo } from "@/features/onboarding/SpeechDemo";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { PasteStep } from "@/features/onboarding/PasteStep";
import { FirstTranscriptGuide } from "@/features/onboarding/FirstTranscriptGuide";
import { OnboardingWorkspaceCard } from "@/features/onboarding/OnboardingWorkspaceCard";
import { FloatingRecorderHud } from "@/features/overlay/FloatingRecorderHud";
import App from "@/App";
import CallApp from "@/CallApp";
import { he } from "@shared/locale";
import type { CallState, DictionaryEntry, OverlayPosition, OverlaySession } from "@shared/types";
import type { ThemeId } from "@shared/themes";
import { LabProvider, makeSettings, onboardingAt, transcripts, type LabSeed } from "./fixtures";
import { answerBridge, logLabCall } from "./mock-bridge";

export interface Story { id: string; group: string; name: string; source: string; render: () => ReactNode }

type Size = "auto" | "screen" | "hud" | "narrow";

/** One labelled state of a component. The frame contains fixed-position children such as toasts. */
export function State({ label, size = "auto", children }: { label: string; size?: Size; children: ReactNode }) {
  return <figure className="lab-state" data-size={size} data-lab-state={label}>
    <figcaption>{label}</figcaption>
    <div className="lab-state-body"><StateBoundary>{children}</StateBoundary></div>
  </figure>;
}

/** One broken state shows its error instead of blanking the whole lab. */
class StateBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    return this.state.error ? <pre className="lab-error" dir="ltr">{this.state.error.message}</pre> : this.props.children;
  }
}

const log = (name: string) => (...args: unknown[]) => logLabCall(`prop.${name}`, args);
const resolved = (name: string) => async (...args: unknown[]) => { logLabCall(`prop.${name}`, args); };
const ago = (ms: number) => Date.now() - ms;
const With = ({ seed, children }: { seed?: LabSeed; children: ReactNode }) => <LabProvider seed={seed}>{children}</LabProvider>;

const VARIANTS = ["default", "secondary", "ghost", "destructive", "link", "plain"] as const;
const SIZES = ["lg", "default", "sm"] as const;
const ICON_SIZES = ["icon-lg", "icon", "icon-sm", "icon-xs"] as const;

function ButtonsStory() {
  return <>
    {VARIANTS.map(variant => <State key={variant} label={`variant="${variant}"`}>
      <div className="lab-row">
        {SIZES.map(size => <Button key={size} variant={variant} size={size}>{size === "default" ? "שמירה" : size === "lg" ? "המשך להגדרה" : "ביטול"}</Button>)}
        {ICON_SIZES.map(size => <Button key={size} variant={variant} size={size} aria-label={size}><Icons.Copy /></Button>)}
        <Button variant={variant} disabled>מושבת</Button>
        <Button variant={variant} aria-busy="true" aria-disabled="true">שומרים…</Button>
      </div>
    </State>)}
  </>;
}

function FieldsStory() {
  const [text, setText] = useState("מלולי");
  return <>
    <State label="Input"><div className="lab-column">
      <Input placeholder="ריק, עם placeholder" />
      <Input value={text} onChange={event => setText(event.target.value)} />
      <Input dir="ltr" defaultValue="https://www.youtube.com/watch?v=lab" />
      <Input aria-invalid defaultValue="ערך שגוי" />
      <Input disabled defaultValue="מושבת" />
    </div></State>
    <State label="Select"><div className="lab-row">
      <Select defaultValue="balanced"><option value="fast">מהיר</option><option value="balanced">מאוזן</option><option value="accurate">מדויק</option></Select>
      <Select disabled defaultValue="a"><option value="a">מושבת</option></Select>
    </div></State>
    <State label="Switch"><div className="lab-row">
      <Switch defaultChecked aria-label="פועל" /><Switch aria-label="כבוי" /><Switch disabled aria-label="מושבת" /><Switch disabled defaultChecked aria-label="מושבת ופועל" />
    </div></State>
  </>;
}

function IconsStory() {
  const entries = Object.entries(Icons).filter(([, value]) => typeof value === "function") as [string, () => ReactNode][];
  return <State label={`${entries.length} SF Symbols (pnpm symbols)`}>
    <div className="lab-icon-grid">
      {entries.map(([name, Icon]) => <div key={name} className="lab-icon"><Icon /><code>{name}</code></div>)}
    </div>
  </State>;
}

/** A synthetic voice: an oscillator with a wobbling gain. It never touches the microphone and plays nothing aloud. */
function useSyntheticVoice() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const start = () => {
    const context = new AudioContext();
    const voice = context.createOscillator(), gain = context.createGain(), wobble = context.createOscillator(), depth = context.createGain();
    voice.type = "sawtooth"; voice.frequency.value = 160;
    wobble.frequency.value = 3.2; depth.gain.value = .5; gain.gain.value = .5;
    wobble.connect(depth).connect(gain.gain);
    const destination = context.createMediaStreamDestination();
    voice.connect(gain).connect(destination);
    voice.start(); wobble.start();
    audio.current = context;
    setStream(destination.stream);
  };
  const stop = () => { void audio.current?.close(); audio.current = null; setStream(null); };
  useEffect(() => () => { void audio.current?.close(); }, []);
  return { stream, start, stop };
}

function VisualizerStory() {
  const voice = useSyntheticVoice();
  const states: AgentState[] = ["idle", "listening", "speaking", "thinking", "connecting", "downloading"];
  return <>
    <State label="צליל סינתטי (לא מיקרופון)">
      <div className="lab-row">
        <Button size="sm" variant="secondary" onClick={voice.stream ? voice.stop : voice.start}>{voice.stream ? "עצירת הצליל" : "הפעלת צליל בדיקה"}</Button>
        <BarVisualizer state="speaking" mediaStream={voice.stream} />
      </div>
    </State>
    {states.map(state => <State key={state} label={`state="${state}"`}><BarVisualizer state={state} /></State>)}
    <State label="barCount=28"><BarVisualizer state="speaking" barCount={28} mediaStream={voice.stream} /></State>
  </>;
}

function RecordButtonsStory() {
  return <>
    <State label="מוכן"><div className="capsule"><RecordButton mode="start" onClick={log("start")}><kbd dir="ltr">⌥ Space</kbd></RecordButton></div></State>
    <State label="מקליט"><div className="capsule control-dock"><RecordButton mode="pause" onClick={log("pause")} /><RecordButton mode="stop" onClick={log("stop")} /></div></State>
    <State label="מושהה"><div className="capsule control-dock"><RecordButton mode="resume" onClick={log("resume")} /><RecordButton mode="stop" onClick={log("stop")} /></div></State>
    <State label="מעבד (שקט)"><div className="capsule control-dock" data-quiet="true"><RecordButton mode="cancel" onClick={log("cancel")} /></div></State>
    <State label="מושבת"><div className="capsule" data-quiet="true"><RecordButton mode="start" disabled onClick={log("start")} /></div></State>
  </>;
}

function CopyStory() {
  return <>
    <State label="secondary"><CopyButton text="טקסט לדוגמה" /></State>
    <State label="emphasized"><CopyButton text="טקסט לדוגמה" emphasized /></State>
    <State label="iconOnly"><CopyButton text="טקסט לדוגמה" iconOnly /></State>
    <State label="ריק (מושבת)"><CopyButton text="" /></State>
  </>;
}

function SearchStory() {
  const [empty, setEmpty] = useState("");
  const [filled, setFilled] = useState("פגישה");
  return <>
    <State label="ריק"><SearchInput value={empty} onChange={setEmpty} placeholder={he.searchPlaceholder} /></State>
    <State label="עם ערך"><SearchInput value={filled} onChange={setFilled} placeholder={he.searchPlaceholder} /></State>
  </>;
}

function ShortcutStory() {
  return <>
    <State label="שמירה מצליחה"><ShortcutEditor id="lab-shortcut" label="קיצור להקלטה" description="לחיצה ותיכף מתחילים" value="Alt+Space" onSave={resolved("onSave")} /></State>
    <State label="שמירה נכשלת"><ShortcutEditor id="lab-shortcut-fail" label="קיצור לחלון הצף" description="לחצו כאן ואז את הצירוף" value="CommandOrControl+Shift+M"
      onSave={async () => { throw new Error("lab"); }} /></State>
  </>;
}

function ToastStory() {
  const messages = ["ההקלטה נשמרה בהיסטוריה.", "המיקרופון לא זמין. אפשר לבחור מיקרופון אחר בהגדרות.", "ההעתקה לא הצליחה. אפשר לבחור את הטקסט ולהעתיק ידנית.", "לא הצלחנו להוריד את הסרטון. כדאי לבדוק את הקישור."];
  const [message, setMessage] = useState(messages[0]!);
  const [count, setCount] = useState(1);
  return <State label="מחסנית הודעות" size="screen">
    <div className="lab-row">
      <Button size="sm" variant="secondary" onClick={() => { setMessage(messages[count % messages.length]!); setCount(count + 1); }}>הודעה נוספת</Button>
      <Button size="sm" variant="ghost" onClick={() => setMessage("")}>ניקוי</Button>
    </div>
    <NoticeToast message={message} onDismiss={() => setMessage("")} urgent={message !== messages[0]} />
  </State>;
}

function MarksStory() {
  return <>
    <State label="LoadingMark"><LoadingMark /></State>
    <State label='EmptyMark kind="history"'><EmptyMark kind="history" /></State>
    <State label='EmptyMark kind="dictionary"'><EmptyMark kind="dictionary" /></State>
    <State label='EmptyMark kind="search"'><EmptyMark kind="search" /></State>
  </>;
}

const recordingStates: Array<[string, LabSeed]> = [
  ["מוכן", {}],
  ["מתכונן", { recording: { isPreparing: true } }],
  ["מקליט", { appState: { status: "recording", timerStartedAt: ago(12_400), activeSourceType: "microphone" } }],
  ["מושהה", { appState: { status: "paused", timerStartedAt: 48_000, activeSourceType: "microphone" } }],
  ["מעבד", { appState: { status: "processing", timerStartedAt: null, processingStartedAt: ago(3_000), processingEstimateMs: 9_000, processingProgressRatio: .42, activeSourceType: "microphone" } }],
  ["מוריד מיוטיוב", { appState: { status: "youtube_downloading", timerStartedAt: null, activeSourceType: "youtube", currentYoutubeJob: { url: "https://youtu.be/lab", title: "הרצאה: איך עובד זיהוי דיבור" } } }],
  ["שגיאה", { appState: { status: "error", timerStartedAt: null, lastError: "התמלול נכשל. אפשר לנסות שוב." } }],
  ["אין מנוע", { settings: settings => { settings.modelState.downloadState = "missing"; } }],
  ["מיקרופון חסום", { permissionStatus: "denied" }],
  ["בלי קישורים", { appState: { linkImportAvailable: false } }]
];

const callStates: Array<[string, Partial<CallState>]> = [
  ["הצעה (Zoom)", { suggestion: "zoom" }],
  ["הצעה (Teams)", { suggestion: "teams" }],
  ["הצעה (דפדפן)", { suggestion: "browser" }],
  ["מקליט שיחה", { recording: { app: "browser", startedAt: ago(184_000) } }],
  ["מעבד שיחה", { processing: { progressRatio: .6, waiting: false } }],
  ["ממתין לעיבוד", { processing: { progressRatio: 0, waiting: true } }],
  ["כשל", { failures: [{ id: "f1", app: "teams", startedAt: ago(3_600_000) }] }],
  ["אין דיבור", { notice: "no_speech" }]
];
const callWindowStates = callStates.slice(0, 4);
// Suggestions and live recording belong to the call window, so the workspace shows only these.
const callStatusStates: Array<[string, Partial<CallState>]> = [
  ...callStates.slice(4),
  ["הצד השני שקט", { notice: "others_silent" }],
  ["צריך מיקרופון", { notice: "needs_microphone" }],
  ["מעט מקום בדיסק", { notice: "low_disk" }]
];
const callState = (patch: Partial<CallState>): CallState => ({ available: true, suggestion: null, recording: null, processing: null, failures: [], notice: null, ...patch });

function DictionaryStory() {
  const [entries, setEntries] = useState<DictionaryEntry[]>(makeSettings().dictionary);
  const [empty, setEmpty] = useState<DictionaryEntry[]>([]);
  return <>
    <State label="עם מילים"><DictionarySection entries={entries} busy={false} onChange={setEntries} /></State>
    <State label="ריק"><DictionarySection entries={empty} busy={false} onChange={setEmpty} /></State>
    <State label="busy"><DictionarySection entries={entries} busy onChange={log("onChange")} /></State>
  </>;
}

function SettingsPartsStory() {
  const [on, setOn] = useState(true);
  const [theme, setTheme] = useState<ThemeId>("meluli-dark");
  const [position, setPosition] = useState<OverlayPosition>("bottom");
  return <>
    <State label="SettingsRow + Switch"><SettingsRow title="הסרת מילות מילוי" description="אממ, אה ודומיהן לא ייכנסו לטקסט"><Switch checked={on} onCheckedChange={setOn} aria-label="הסרת מילות מילוי" /></SettingsRow></State>
    <State label="SettingsRow + Select + detail"><SettingsRow title="מהירות" description="מאוזן מתאים לרוב השימושים" detail={<span>זמן עיבוד משוער: 2 שניות לדקה</span>}>
      <Select defaultValue="balanced"><option value="fast">מהיר</option><option value="balanced">מאוזן</option><option value="accurate">מדויק</option></Select>
    </SettingsRow></State>
    <State label="ThemePicker"><span id="lab-theme-label" className="sr-only">ערכת צבעים</span><ThemePicker value={theme} labelledBy="lab-theme-label" onChange={setTheme} /></State>
    <State label="OverlayPositionPicker"><span id="lab-pos-label" className="sr-only">מיקום</span><span id="lab-pos-desc" className="sr-only">איפה החלון הצף מופיע</span>
      <OverlayPositionPicker value={position} labelledBy="lab-pos-label" describedBy="lab-pos-desc" onChange={setPosition} /></State>
  </>;
}

function MicrophoneStory() {
  const states = [
    ["לא נבדק", { permissionStatus: "not-determined", status: "idle" }],
    ["מבקש הרשאה", { permissionStatus: "not-determined", status: "requesting" }],
    ["מקשיב", { permissionStatus: "granted", status: "listening", level: .25 }],
    ["זוהה קול", { permissionStatus: "granted", status: "detected", level: .8 }],
    ["שגיאה", { permissionStatus: "granted", status: "error", error: "לא שמענו כלום. כדאי לבדוק שהמיקרופון הנכון נבחר." }],
    ["הרשאה נדחתה", { permissionStatus: "denied", status: "idle" }],
    ["לא זמין", { permissionStatus: "granted", status: "idle", unavailable: true }]
  ] as const;
  return <>{states.map(([label, props]) => <State key={label} label={label}>
    <MicrophoneStep {...props} onSelectDevice={log("onSelectDevice")} />
  </State>)}</>;
}

function ModelStory() {
  const missing = makeSettings(s => { s.modelState.downloadState = "missing"; s.modelState.bytesDownloaded = 0; });
  const downloading = makeSettings(s => { s.modelState.downloadState = "downloading"; s.modelState.bytesDownloaded = 680_000_000; });
  const failed = makeSettings(s => { s.modelState.downloadState = "error"; s.modelState.lastError = "ההורדה נקטעה. אפשר לנסות שוב."; });
  return <>
    <State label="חסר"><ModelDownloadStep settings={missing} progress={null} /></State>
    <State label="מוריד 42%"><ModelDownloadStep settings={downloading} progress={{ bytesDownloaded: 680_000_000, totalBytes: 1_620_000_000, percent: 42 }} /></State>
    <State label="שגיאה"><ModelDownloadStep settings={failed} progress={null} /></State>
    <State label="מוכן"><ModelDownloadStep settings={makeSettings()} progress={null} /></State>
  </>;
}

function BottomBarStory() {
  return <>
    <State label="ראשון"><OnboardingBottomBar primaryContent="בואו נתחיל" onPrimary={log("onPrimary")} /></State>
    <State label="אמצע, עם חזרה ודילוג"><OnboardingBottomBar primaryContent="המשך" onPrimary={log("onPrimary")} onSkip={log("onSkip")} onBack={log("onBack")} showBack /></State>
    <State label="ממתין"><OnboardingBottomBar primaryContent="מורידים…" onPrimary={log("onPrimary")} primaryPending showBack onBack={log("onBack")} /></State>
    <State label="מושבת"><OnboardingBottomBar primaryContent="המשך" onPrimary={log("onPrimary")} primaryDisabled /></State>
  </>;
}

const session = (phase: OverlaySession["phase"], extra: Partial<OverlaySession> = {}): OverlaySession =>
  ({ id: `lab-${phase}`, phase, transcriptId: null, transcriptText: null, targetAppName: "Notes", lastErrorCode: null, ...extra });

const hudStates: Array<[string, LabSeed]> = [
  ["מוכן", {}],
  ["מקליט", { appState: { status: "recording", timerStartedAt: ago(6_200), activeSourceType: "microphone", overlaySession: session("recording") } }],
  ["מושהה", { appState: { status: "paused", timerStartedAt: 21_000, activeSourceType: "microphone", overlaySession: session("recording") } }],
  ["מתכונן", { recording: { isPreparing: true }, appState: { overlaySession: session("recording") } }],
  ["קרוב למגבלה", { appState: { status: "recording", timerStartedAt: ago(19.5 * 60_000), activeSourceType: "microphone", overlaySession: session("recording") } }],
  ["מעבד", { appState: { status: "processing", timerStartedAt: null, processingStartedAt: ago(1_000), processingEstimateMs: 4_000, processingProgressRatio: .3, activeSourceType: "microphone", overlaySession: session("processing") } }],
  ["הודבק", { appState: { status: "idle", timerStartedAt: null, overlaySession: session("success", { transcriptId: "t-mic", transcriptText: transcripts[0]!.text, insertionOutcome: "confirmed", deliveredInApp: true }) } }],
  ["ההדבקה נכשלה", { appState: { status: "idle", timerStartedAt: null, overlaySession: session("paste_failed", { transcriptId: "t-mic", transcriptText: transcripts[0]!.text, lastErrorCode: "secure_field" }) } }],
  ["החלון השתנה", { appState: { status: "idle", timerStartedAt: null, overlaySession: session("paste_failed", { transcriptId: "t-mic", transcriptText: transcripts[0]!.text, lastErrorCode: "target_changed", targetAppName: "Slack" }) } }],
  ["העתקה ידנית בלבד", { appState: { status: "idle", timerStartedAt: null, overlaySession: session("paste_failed", { transcriptId: "t-mic", transcriptText: transcripts[0]!.text, lastErrorCode: "secure_field", manualCopyOnly: true, insertionOutcome: "unknown" }) } }],
  ["בוטל, אפשר לשחזר", { recording: { heldRecording: { reason: "canceled", durationMs: 8_400 } } }],
  ["התמלול נכשל, שליחה חוזרת", { recording: { heldRecording: { reason: "failed", durationMs: 8_400 } } }],
  ["תצוגה חיה", { appState: { status: "recording", timerStartedAt: ago(4_800), activeSourceType: "microphone", overlaySession: session("recording") },
    recording: { livePreview: { sessionId: "lab", text: "אני רוצה לקבוע פגישה ליום שלישי בבוקר", stableText: "אני רוצה לקבוע פגישה", audioSamples: 76_800, decodedSamples: 64_000 } } }],
  ["אין הרשאת נגישות", { accessibilityPermissionStatus: "denied", appState: { status: "idle", timerStartedAt: null, overlaySession: session("paste_failed", { transcriptId: "t-mic", transcriptText: transcripts[0]!.text, lastErrorCode: "permission" }) } }],
  ["אין גישה למיקרופון", { permissionStatus: "denied" }],
  ["המנוע עוד יורד", { settings: s => { s.modelState.downloadState = "downloading"; } }],
  ["ההגדרה לא הסתיימה", { settings: onboardingAt("needs_mic") }],
  ["שגיאה רגילה (נעלמת אחרי 5 שניות)", { errorMessage: "ההקלטה נכשלה. אפשר לנסות שוב." }],
  ["מעבד, זמן ארוך", { appState: { status: "processing", timerStartedAt: null, processingStartedAt: ago(1_000), processingEstimateMs: 80_000, processingProgressRatio: .1, activeSourceType: "microphone", overlaySession: session("processing") } }]
];

function CallAppStory() {
  const [index, setIndex] = useState(0);
  const [label, patch] = callWindowStates[index]!;
  answerBridge("app.state", () => ({ status: "idle", timerStartedAt: null, call: callState(patch) }));
  answerBridge("settings.get", () => makeSettings());
  return <State label={label} size="hud">
    <div className="lab-row lab-switcher">{callWindowStates.map(([name], i) => <Button key={name} size="sm" variant={i === index ? "secondary" : "ghost"} onClick={() => setIndex(i)}>{name}</Button>)}</div>
    <div className="lab-desktop"><CallApp key={index} /></div>
  </State>;
}

const appStates: Array<[string, LabSeed]> = [
  ["בית", {}],
  ["בית — מקליט", { appState: { status: "recording", timerStartedAt: ago(9_000), activeSourceType: "microphone" } }],
  ["היסטוריה", { activeView: "history" }],
  ["מילון", { activeView: "dictionary" }],
  ["הגדרות", { activeView: "settings" }],
  ["אודות", { activeView: "about" }],
  ["הגדרה ראשונית", { settings: onboardingAt("not_started"), permissionStatus: "not-determined" }],
  ["טוען", { loading: true }],
  ["ההפעלה נכשלה", { loadFailed: true }],
  ["עם הודעת שגיאה", { errorMessage: "התמלול נכשל. אפשר לנסות שוב." }],
  ["בלי תמלולים", { transcripts: [], lastTranscript: null }],
  ["אין מנוע תמלול", { settings: s => { s.modelState.downloadState = "missing"; s.modelState.bytesDownloaded = 0; } }],
  ["מוריד את המנוע", { settings: s => { s.modelState.downloadState = "downloading"; s.modelState.bytesDownloaded = 680_000_000; }, modelProgress: { bytesDownloaded: 680_000_000, totalBytes: 1_620_000_000, percent: 42 } }]
];

const G = { base: "יסודות", shared: "רכיבים משותפים", home: "בית", transcript: "תמלול", library: "היסטוריה ומילון", settings: "הגדרות", onboarding: "הגדרה ראשונה", overlay: "חלון צף ושיחות", screens: "מסכים מלאים" };

export const stories: Story[] = [
  { id: "button", group: G.base, name: "Button", source: "components/ui/button.tsx", render: () => <ButtonsStory /> },
  { id: "fields", group: G.base, name: "Input · Select · Switch", source: "components/ui/", render: () => <FieldsStory /> },
  { id: "icons", group: G.base, name: "Icons", source: "components/icons.tsx", render: () => <IconsStory /> },
  { id: "visualizer", group: G.base, name: "BarVisualizer", source: "components/ui/bar-visualizer.tsx", render: () => <VisualizerStory /> },

  { id: "record-button", group: G.shared, name: "RecordButton", source: "components/RecordButton.tsx", render: () => <RecordButtonsStory /> },
  { id: "copy-button", group: G.shared, name: "CopyButton", source: "components/CopyButton.tsx", render: () => <CopyStory /> },
  { id: "search", group: G.shared, name: "SearchInput", source: "components/SearchInput.tsx", render: () => <SearchStory /> },
  { id: "shortcut", group: G.shared, name: "ShortcutEditor", source: "components/ShortcutEditor.tsx", render: () => <ShortcutStory /> },
  { id: "toast", group: G.shared, name: "NoticeToast", source: "components/NoticeToast.tsx", render: () => <ToastStory /> },
  { id: "marks", group: G.shared, name: "LoadingMark · EmptyMark", source: "components/LoadingMark.tsx", render: () => <MarksStory /> },

  { id: "recording-area", group: G.home, name: "RecordingArea", source: "features/workspace/RecordingArea.tsx",
    render: () => <>{recordingStates.map(([label, seed]) => <State key={label} label={label}><With seed={seed}><RecordingArea /></With></State>)}</> },
  { id: "file-drop", group: G.home, name: "FileDropCell", source: "features/workspace/FileDropCell.tsx", render: () => <>
    <State label="פעיל"><FileDropCell disabled={false} onPick={log("onPick")} onDropFile={log("onDropFile")} /></State>
    <State label="מושבת"><FileDropCell disabled onPick={log("onPick")} onDropFile={log("onDropFile")} /></State>
  </> },
  { id: "youtube", group: G.home, name: "YouTubeInputRow", source: "features/workspace/YouTubeInputRow.tsx", render: () => <>
    <State label="ריק"><With><YouTubeInputRow /></With></State>
    <State label="בתור"><With seed={{ appState: { status: "processing", timerStartedAt: null, pendingYoutubeJob: { url: "https://youtu.be/next", title: "הסרטון הבא" } } }}><YouTubeInputRow /></With></State>
  </> },
  { id: "sites", group: G.home, name: "SupportedSitesInfo", source: "features/workspace/SupportedSitesInfo.tsx", render: () => <State label="לוחצים על הסמל לפתיחת החלונית"><div className="lab-row"><span>אתרים נתמכים</span><SupportedSitesInfo /></div></State> },
  { id: "recent", group: G.home, name: "RecentTranscripts", source: "features/workspace/RecentTranscripts.tsx", render: () => <>
    <State label="עם תמלולים"><With><RecentTranscripts /></With></State>
    <State label="ריק"><With seed={{ transcripts: [], lastTranscript: null }}><RecentTranscripts /></With></State>
  </> },
  { id: "call-status", group: G.home, name: "CallStatus", source: "features/workspace/CallStatus.tsx",
    render: () => <>{callStatusStates.map(([label, patch]) => <State key={label} label={label}><With seed={{ appState: { call: callState(patch) } }}><CallStatus /></With></State>)}</> },
  { id: "workspace", group: G.home, name: "WorkspaceView", source: "features/workspace/WorkspaceView.tsx", render: () => <>
    <State label="רגיל"><With><WorkspaceView /></With></State>
    <State label="בלי תמלול אחרון"><With seed={{ lastTranscript: null, transcripts: [] }}><WorkspaceView /></With></State>
    <State label="מיקרופון חסום"><With seed={{ permissionStatus: "denied" }}><WorkspaceView /></With></State>
    <State label="הגדרה בבית: מנוע חסר"><With seed={{ settings: onboardingAt("needs_model", "workspace") }}><WorkspaceView /></With></State>
    <State label="מדריך תמלול ראשון"><With seed={{ settings: onboardingAt("needs_first_transcript", "workspace"), lastTranscript: null }}><WorkspaceView /></With></State>
  </> },

  { id: "transcript-document", group: G.transcript, name: "TranscriptDocument", source: "features/transcript/TranscriptDocument.tsx",
    render: () => <>{transcripts.map(transcript => <State key={transcript.id} label={transcript.sourceType}><With><TranscriptDocument transcript={transcript} onClose={log("onClose")} /></With></State>)}</> },
  { id: "transcript-editor", group: G.transcript, name: "TranscriptEditor", source: "features/transcript/TranscriptEditor.tsx", render: () => <>
    <State label="טקסט חופשי"><With><TranscriptEditor transcript={transcripts[1]!} onDone={log("onDone")} /></With></State>
    <State label="מתוזמן (קטעים)"><With><TranscriptEditor transcript={transcripts[3]!} onDone={log("onDone")} /></With></State>
  </> },

  { id: "history-list", group: G.library, name: "HistoryList", source: "features/history/HistoryList.tsx",
    render: () => <State label="רשימה"><HistoryListDemo /></State> },
  { id: "history-panel", group: G.library, name: "HistoryPanel", source: "features/history/HistoryPanel.tsx", render: () => <>
    <State label="עם תמלולים" size="screen"><With><HistoryPanel /></With></State>
    <State label="ריק" size="screen"><With seed={{ transcripts: [], lastTranscript: null }}><HistoryPanel /></With></State>
  </> },
  { id: "dictionary-section", group: G.library, name: "DictionarySection", source: "features/dictionary/DictionarySection.tsx", render: () => <DictionaryStory /> },
  { id: "dictionary-view", group: G.library, name: "DictionaryView", source: "features/dictionary/DictionaryView.tsx", render: () => <>
    <State label="עם מילים"><With><DictionaryView /></With></State>
    <State label="ריק"><With seed={{ settings: s => { s.dictionary = []; } }}><DictionaryView /></With></State>
  </> },

  { id: "settings-parts", group: G.settings, name: "SettingsRow · ThemePicker · OverlayPositionPicker", source: "features/settings/", render: () => <SettingsPartsStory /> },
  { id: "settings-view", group: G.settings, name: "SettingsView", source: "features/settings/SettingsView.tsx", render: () => <>
    <State label="רגיל"><With><SettingsView /></With></State>
    <State label="מוריד מנוע"><With seed={{ settings: s => { s.modelState.downloadState = "downloading"; }, modelProgress: { bytesDownloaded: 680_000_000, totalBytes: 1_620_000_000, percent: 42 } }}><SettingsView /></With></State>
    <State label="מנוע חסר"><With seed={{ settings: s => { s.modelState.downloadState = "missing"; } }}><SettingsView /></With></State>
    <State label="מיקרופון חסום"><With seed={{ permissionStatus: "denied" }}><SettingsView /></With></State>
    <State label="עדכון מוכן"><With seed={{ appState: { update: { status: "ready", version: "0.2.0" } } }}><SettingsView /></With></State>
    <State label="מקש החזקה צריך הרשאה"><With seed={{ appState: { holdKey: { status: "needs_permission" } } }}><SettingsView /></With></State>
  </> },
  { id: "info-page", group: G.settings, name: "InfoPage", source: "features/info/InfoPage.tsx", render: () => <>
    <State label="אודות"><InfoPage title={he.aboutPageTitle} sections={he.aboutPageSections} onBack={log("onBack")} showVersion><Button size="sm" variant="secondary">{he.sourceCode}</Button></InfoPage></State>
    <State label="תנאי שימוש"><InfoPage title={he.termsPageTitle} sections={he.termsPageSections} footnote={he.legalLastUpdated} onBack={log("onBack")} /></State>
    <State label="מדיניות פרטיות"><InfoPage title={he.privacyPageTitle} sections={he.privacyPageSections} footnote={he.legalLastUpdated} onBack={log("onBack")} /></State>
  </> },

  { id: "step-shell", group: G.onboarding, name: "OnboardingStepShell · WelcomeStep", source: "features/onboarding/OnboardingStepShell.tsx", render: () => <>
    <State label="WelcomeStep"><WelcomeStep actions={<OnboardingBottomBar primaryContent="בואו נתחיל" onPrimary={log("onPrimary")} />} /></State>
    <State label="Shell כללי"><OnboardingStepShell stepLabel="שלב לדוגמה" title="כותרת השלב" description="תיאור קצר שמסביר מה קורה כאן ולמה זה חשוב."><div className="lab-placeholder">תוכן השלב</div></OnboardingStepShell></State>
  </> },
  { id: "microphone-step", group: G.onboarding, name: "MicrophoneStep", source: "features/onboarding/MicrophoneStep.tsx", render: () => <MicrophoneStory /> },
  { id: "model-step", group: G.onboarding, name: "ModelDownloadStep", source: "features/onboarding/ModelDownloadStep.tsx", render: () => <ModelStory /> },
  { id: "bottom-bar", group: G.onboarding, name: "OnboardingBottomBar", source: "features/onboarding/OnboardingBottomBar.tsx", render: () => <BottomBarStory /> },
  { id: "speech-demo", group: G.onboarding, name: "SpeechDemo", source: "features/onboarding/SpeechDemo.tsx", render: () => <State label="ברירת מחדל"><SpeechDemo /></State> },
  { id: "onboarding-flow", group: G.onboarding, name: "OnboardingFlow", source: "features/onboarding/OnboardingFlow.tsx", render: () => <>
    <State label="היכרות" size="screen"><With seed={{ settings: onboardingAt("not_started"), permissionStatus: "not-determined" }}><OnboardingFlow /></With></State>
    <State label="מיקרופון" size="screen"><With seed={{ settings: onboardingAt("needs_mic"), permissionStatus: "not-determined" }}><OnboardingFlow /></With></State>
    <State label="הדבקה" size="screen"><With seed={{ settings: onboardingAt("needs_paste"), accessibilityPermissionStatus: "denied" }}><OnboardingFlow /></With></State>
    <State label="הדבקה: מחכים" size="screen"><With seed={{ settings: onboardingAt("needs_paste"), accessibilityPermissionStatus: "denied" }}><PasteStep allowed={false} waiting /></With></State>
    <State label="הדבקה: אושרה" size="screen"><With seed={{ settings: onboardingAt("needs_paste") }}><PasteStep allowed waiting={false} /></With></State>
    <State label="מקש החזקה" size="screen"><With seed={{ settings: onboardingAt("needs_hold_key") }}><OnboardingFlow /></With></State>
    <State label="מנוע" size="screen"><With seed={{ settings: onboardingAt("needs_model") }}><OnboardingFlow /></With></State>
  </> },
  { id: "first-transcript", group: G.onboarding, name: "FirstTranscriptGuide · WorkspaceCard", source: "features/onboarding/FirstTranscriptGuide.tsx", render: () => <>
    <State label="FirstTranscriptGuide"><With seed={{ settings: onboardingAt("needs_first_transcript", "workspace") }}><FirstTranscriptGuide /></With></State>
    <State label="FirstTranscriptGuide — בלי נגישות"><With seed={{ settings: onboardingAt("needs_first_transcript", "workspace"), accessibilityPermissionStatus: "denied" }}><FirstTranscriptGuide /></With></State>
    <State label="OnboardingWorkspaceCard — מנוע"><With seed={{ settings: onboardingAt("needs_model", "workspace") }}><OnboardingWorkspaceCard phase="needs_model" onResumeSetup={log("onResumeSetup")} /></With></State>
    <State label="OnboardingWorkspaceCard — מוריד"><With seed={{ settings: s => { onboardingAt("needs_model", "workspace")(s); s.modelState.downloadState = "downloading"; }, modelProgress: { bytesDownloaded: 400_000_000, totalBytes: 1_620_000_000, percent: 25 } }}>
      <OnboardingWorkspaceCard phase="needs_model" onResumeSetup={log("onResumeSetup")} /></With></State>
  </> },

  { id: "hud", group: G.overlay, name: "FloatingRecorderHud", source: "features/overlay/FloatingRecorderHud.tsx",
    render: () => <>{hudStates.map(([label, seed]) => <State key={label} label={label} size="hud"><div className="lab-desktop"><With seed={seed}><FloatingRecorderHud /></With></div></State>)}</> },
  { id: "call-app", group: G.overlay, name: "CallApp", source: "CallApp.tsx", render: () => <CallAppStory /> },

  { id: "app", group: G.screens, name: "App", source: "App.tsx",
    render: () => <>{appStates.map(([label, seed]) => <State key={label} label={label} size="screen"><With seed={seed}><App /></With></State>)}</> }
];

function HistoryListDemo() {
  const [selected, setSelected] = useState<string | null>(transcripts[0]!.id);
  return <HistoryList items={transcripts} selectedId={selected} onSelect={setSelected} />;
}
