import { MilestoneScope } from "./components/milestone-sweep";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import appIcon from "@/assets/app-icon.png";
import { BookClosed, ClockCounterClockwise, GearSix, House, Wand } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { LoadingMark } from "@/components/LoadingMark";
import { SearchInput } from "@/components/SearchInput";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { WorkspaceView } from "@/features/workspace/WorkspaceView";
import { useAppContext } from "@/context/app-context";
import { usePointerFeedback } from "@/components/usePointerFeedback";
import { NoticeToast } from "@/components/NoticeToast";
import { REPOSITORY_URL } from "@shared/constants";
import { he } from "@shared/locale";
import type { MainView } from "@shared/types";

const HistoryPanel = lazy(() => import("@/features/history/HistoryPanel").then(m => ({ default: m.HistoryPanel })));
const DictionaryView = lazy(() => import("@/features/dictionary/DictionaryView").then(m => ({ default: m.DictionaryView })));
const FlowsView = lazy(() => import("@/features/flows/FlowsView").then(m => ({ default: m.FlowsView })));
const SettingsView = lazy(() => import("@/features/settings/SettingsView").then(m => ({ default: m.SettingsView })));
const InfoPage = lazy(() => import("@/features/info/InfoPage").then(m => ({ default: m.InfoPage })));

const INFO_PAGES = {
  about: { title: he.aboutPageTitle, sections: he.aboutPageSections },
  terms: { title: he.termsPageTitle, sections: he.termsPageSections, footnote: he.legalLastUpdated },
  privacy: { title: he.privacyPageTitle, sections: he.privacyPageSections, footnote: he.legalLastUpdated }
};
const isInfoView = (view: MainView): view is keyof typeof INFO_PAGES => view in INFO_PAGES;

export default function App() {
  usePointerFeedback();
  const { loading, loadFailed, settings, onboarding, accessibilityPermissionStatus, activeView, setActiveView, appState, errorMessage, setErrorMessage, lastTranscript, transcripts } = useAppContext();
  const showOnboarding = Boolean(onboarding?.showFlow);
  const heading = useRef<HTMLHeadingElement>(null);
  const mainContent = useRef<HTMLElement>(null);
  const homeButton = useRef<HTMLButtonElement>(null);
  const previousView = useRef(`${showOnboarding}:${activeView}`);
  const returnFocus = useRef<HTMLElement | null>(null);
  // ⌘C copies without a button to say so, so a short notice does.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // Search belongs to History; a query left behind would quietly filter Home's recent list.
  const { searchQuery, setSearchQuery } = transcripts;
  useEffect(() => { if (activeView !== "history" && searchQuery) setSearchQuery(""); }, [activeView, searchQuery, setSearchQuery]);
  const navigate = (view: MainView) => {
    setActiveView(view);
  };

  useEffect(() => {
    const view = `${showOnboarding}:${activeView}`;
    if (previousView.current !== view) {
      previousView.current = view;
      heading.current?.focus();
      // The links to these pages sit at the bottom of Settings, in the same scrolling area.
      if (mainContent.current && isInfoView(activeView)) mainContent.current.scrollTop = 0;
    }
  }, [activeView, showOnboarding]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeView !== "workspace" && !showOnboarding && !event.defaultPrevented) {
        // Escape inside a field belongs to the field, so a half-typed entry is never thrown away.
        const field = event.target;
        if (field instanceof HTMLElement && (field.matches("input, textarea, select") || field.isContentEditable)) return;
        event.preventDefault();
        if (isInfoView(activeView)) {
          setActiveView("settings");
          return;
        }
        const origin = returnFocus.current;
        setActiveView("workspace");
        requestAnimationFrame(() => {
          if (origin?.isConnected && !origin.closest("[hidden]")) origin.focus();
          else homeButton.current?.focus();
        });
        return;
      }
      // A field that took the key, such as a shortcut being recorded, keeps it.
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.defaultPrevented) return;
      // event.code, so these keep working on a Hebrew keyboard layout.
      if (event.code === "Comma" && !showOnboarding) {
        event.preventDefault();
        setActiveView("settings");
        return;
      }
      if (event.code === "KeyF" && !showOnboarding) {
        event.preventDefault();
        if (activeView !== "history") setActiveView("history");
        requestAnimationFrame(() => document.getElementById("history-search")?.focus());
        return;
      }
      if (event.code !== "KeyC" && event.key.toLowerCase() !== "c") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea") || target.isContentEditable)) return;
      if (window.getSelection()?.toString().trim()) return;
      const text = activeView === "history" ? transcripts.selectedTranscript?.text : activeView === "workspace" ? lastTranscript?.text : null;
      if (!text) return;
      event.preventDefault();
      void window.ivritMenuBar.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setErrorMessage("ההעתקה לא הצליחה. אפשר לבחור את הטקסט ולהעתיק ידנית."));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeView, showOnboarding, lastTranscript, transcripts.selectedTranscript, setActiveView, setErrorMessage]);

  const title = showOnboarding ? "הגדרה ראשונית" : activeView === "workspace" ? "בית" : activeView === "history" ? he.history : activeView === "dictionary" ? he.dictionaryTitle : activeView === "flows" ? "פעולות" : activeView === "settings" ? he.settings : INFO_PAGES[activeView].title;
  const operationStatus = appState.status === "recording" ? he.recording : appState.status === "paused" ? he.paused : appState.status === "processing" ? he.visualizerThinking : appState.status === "youtube_downloading" ? he.visualizerDownloading : "";
  const modelState = settings?.modelState.downloadState;
  const modelReady = modelState === "ready";
  const modelLabel = modelState === "downloading" ? "מורידים מנוע" : "הגדרת מנוע";
  const settingsArea = activeView === "settings" || isInfoView(activeView);
  // Paste already allowed before setup is skipped, so the bar only counts what is still ahead.
  const progressIndex = onboarding?.progressIndex ?? 1;
  const setupSteps = accessibilityPermissionStatus === "granted" && progressIndex < 3
    ? [he.onboardingSetupStepWelcome, he.onboardingSetupStepMicrophone]
    : [he.onboardingSetupStepWelcome, he.onboardingSetupStepMicrophone, he.onboardingSetupStepPaste];

  useEffect(() => { document.title = `${title} — מלולי`; }, [title]);
  // Until the app has loaded, every page would show the same loading or failure surface.
  const navLocked = loading || loadFailed;

  return <MilestoneScope><main className={`desktop-app instrument-app${showOnboarding ? " is-onboarding" : ""}`} onFocusCapture={(event) => {
    if (activeView === "workspace" && !showOnboarding && event.target instanceof HTMLElement && event.target.matches("button, input, select, textarea, a")) returnFocus.current = event.target;
  }}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>דילוג לתוכן הראשי</a>
    {showOnboarding ? <header className="setup-window-header app-drag">
      <div className="instrument-header"><img className="sidebar-brand-mark" src={appIcon} alt="" /><h1>מלולי</h1></div>
      <div className="onboarding-progress" role="group" aria-label={`${setupSteps[Math.min(progressIndex, setupSteps.length) - 1]} · ${he.onboardingStepOfTotal.replace("{current}", String(Math.min(progressIndex, setupSteps.length))).replace("{total}", String(setupSteps.length))}`}>
        <div className="setup-progress-segments" aria-hidden="true">{setupSteps.map((step, index) => <span key={step} data-reached={index < progressIndex} />)}</div>
      </div>
    </header> : <aside className="desktop-sidebar">
      <header className="instrument-header app-drag"><img className="sidebar-brand-mark" src={appIcon} alt="" /><h1>מלולי</h1></header>
      <nav aria-label={he.mainNavigation} className="desktop-navigation">
        <Button ref={homeButton} variant="ghost" data-motion="instant" disabled={navLocked} aria-label={operationStatus ? `בית — ${operationStatus}` : "בית"} aria-current={activeView === "workspace" ? "page" : undefined} onClick={() => navigate("workspace")}>
          <span className="nav-tile"><House /></span><span className="nav-label">בית</span>
          {operationStatus && <><span className="nav-operation-status">{operationStatus}</span><span className="nav-operation-dot" /></>}
        </Button>
        <Button variant="ghost" data-motion="instant" disabled={navLocked} aria-label={he.history} aria-current={activeView === "history" ? "page" : undefined} onClick={() => navigate("history")}><span className="nav-tile"><ClockCounterClockwise /></span><span className="nav-label">{he.history}</span></Button>
        <Button variant="ghost" data-motion="instant" disabled={navLocked} aria-label={he.dictionaryTitle} aria-current={activeView === "dictionary" ? "page" : undefined} onClick={() => navigate("dictionary")}><span className="nav-tile"><BookClosed /></span><span className="nav-label">{he.dictionaryTitle}</span></Button>
        <Button variant="ghost" data-motion="instant" disabled={navLocked} aria-label="פעולות" aria-current={activeView === "flows" ? "page" : undefined} onClick={() => navigate("flows")}><span className="nav-tile"><Wand /></span><span className="nav-label">פעולות</span></Button>
      </nav>
      {!loading && !loadFailed && <footer className="sidebar-footer">
        <Button variant="ghost" data-motion="instant" aria-label={he.settings} aria-current={settingsArea ? "page" : undefined} onClick={() => navigate("settings")}><span className="nav-tile"><GearSix /></span><span className="nav-label">{he.settings}</span></Button>
        {!modelReady && <button type="button" className="model-status" aria-label={`${modelLabel} — ניהול מנוע התמלול`} onClick={() => navigate("settings")}>
          <span className="led" data-tone={modelState === "downloading" ? undefined : "alert"} />
          <span>{modelLabel}</span>
        </button>}
      </footer>}
    </aside>}
    <div className="desktop-main">
      {!showOnboarding && <header className="desktop-toolbar app-drag">
        <h2 ref={heading} className="sr-only" tabIndex={-1}>{title}</h2>
        {/* Search waits for something to search; a typed query keeps it, even with no matches. */}
        {!loading && !loadFailed && activeView === "history" && (transcripts.latestTranscript || transcripts.searchQuery) && <div className="toolbar-tools app-no-drag">
          <div className="toolbar-search"><SearchInput value={transcripts.searchQuery} onChange={transcripts.setSearchQuery} placeholder={he.searchPlaceholder} inputId="history-search" shortcut="⌘F" keyShortcuts="Meta+F" /></div>
        </div>}
      </header>}
      <p className="sr-only" role="status">{activeView !== "workspace" && !showOnboarding ? operationStatus : ""}</p>
      <section ref={mainContent} id="main-content" className="instrument-content" tabIndex={-1}>
        {loadFailed ? <div className="loading-surface" role="alert"><p>{he.startupFailed}</p><Button size="sm" variant="secondary" onClick={() => window.location.reload()}>{he.retry}</Button></div>
        : loading || !settings ? <div className="loading-surface" role="status"><LoadingMark /></div> : showOnboarding ? <OnboardingFlow /> : <>
          {/* Capture stays mounted while navigating between desktop pages. */}
          <div hidden={activeView !== "workspace"}><WorkspaceView /></div>
          <Suspense fallback={<div className="loading-surface" role="status"><LoadingMark /></div>}>
            {activeView === "history" && <HistoryPanel />}
            {activeView === "dictionary" && <DictionaryView />}
            {activeView === "flows" && <FlowsView />}
            {activeView === "settings" && <div className="settings-page"><SettingsView /><footer className="settings-links"><Button size="sm" variant="ghost" onClick={() => navigate("about")}>{he.about}</Button><Button size="sm" variant="ghost" onClick={() => navigate("terms")}>{he.termsOfUse}</Button><Button size="sm" variant="ghost" onClick={() => navigate("privacy")}>{he.privacy}</Button></footer></div>}
            {isInfoView(activeView) && <InfoPage key={activeView} {...INFO_PAGES[activeView]} onBack={() => navigate("settings")} showVersion={activeView === "about"}>
              {activeView === "about" && <>
                <Button size="sm" variant="secondary" onClick={() => void window.ivritMenuBar.app.openLicenses()}>{he.thirdPartyLicenses}</Button>
                <Button size="sm" variant="secondary" onClick={() => void window.ivritMenuBar.files.openExternal(REPOSITORY_URL)}>{he.sourceCode}</Button>
              </>}
            </InfoPage>}
          </Suspense>
        </>}
      </section>
      {!errorMessage && <NoticeToast message={copied ? he.transcriptCopied : ""} onDismiss={() => setCopied(false)} />}
      <NoticeToast message={errorMessage ?? ""} onDismiss={() => setErrorMessage(null)} urgent />
    </div>
  </main></MilestoneScope>;
}
