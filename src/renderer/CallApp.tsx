import { useEffect, useState } from "react";
import { Stop } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format";
import { applyTheme } from "@/lib/theme";
import { he } from "@shared/locale";
import type { CallAppKind, CallState } from "@shared/types";

const SUGGESTION_TITLES: Record<CallAppKind, string> = {
  zoom: he.callSuggestionZoom,
  teams: he.callSuggestionTeams,
  browser: he.callSuggestionBrowser
};

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="hud-time">{formatDurationMs(Math.max(0, now - startedAt))}</span>;
}

/** The only place a call recording begins, and the place it can always be stopped. */
export default function CallApp() {
  const [call, setCall] = useState<CallState | null>(null);

  useEffect(() => {
    void window.ivritMenuBar.app.state().then((state) => setCall(state.call ?? null));
    void window.ivritMenuBar.settings.get().then((settings) => applyTheme(settings.theme));
    const stopState = window.ivritMenuBar.app.onState((state) => setCall(state.call ?? null));
    const stopSettings = window.ivritMenuBar.settings.onChanged((settings) => applyTheme(settings.theme));
    return () => {
      stopState();
      stopSettings();
    };
  }, []);

  if (call?.recording) {
    return <main className="overlay-root">
      <section className="recorder-hud call-pill" aria-label={he.callRecording}>
        <div className="hud-row">
          <span className="hud-caption" role="status">{he.callRecording}</span>
          <Elapsed startedAt={call.recording.startedAt} />
          <Button type="button" variant="plain" className="capsule-round" aria-label={he.callStop} title={he.callStop}
            onClick={() => void window.ivritMenuBar.call.stop()}><Stop /></Button>
        </div>
      </section>
    </main>;
  }

  if (!call?.suggestion) return <main className="overlay-root" />;

  return <main className="overlay-root">
    <section role="dialog" aria-label={SUGGESTION_TITLES[call.suggestion]} className="recorder-hud call-card">
      <strong>{SUGGESTION_TITLES[call.suggestion]}</strong>
      <p>{he.callSuggestionBody}</p>
      <div className="call-actions">
        <Button size="sm" onClick={() => void window.ivritMenuBar.call.accept()}>{he.callAccept}</Button>
        <Button size="sm" variant="secondary" onClick={() => void window.ivritMenuBar.call.dismiss()}>{he.callDismiss}</Button>
      </div>
    </section>
  </main>;
}
