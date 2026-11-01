import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, LinkSimple, X } from "@/components/icons";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { youtubeSubmitInputSchema } from "@shared/schemas";
import { he } from "@shared/locale";
import { useAppContext } from "@/context/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SupportedSitesInfo } from "./SupportedSitesInfo";

/** The link cell: a field that is always ready to paste into. */
export function YouTubeInputRow() {
  const { appState, settings, submitYouTubeUrl, cancelPendingYouTube } = useAppContext();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const helperId = useId();
  const [url, setUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const submitPending = useRef(false);
  const cancelPending = useRef(false);
  const returnAfterCancel = useRef(false);
  const trimmedUrl = url.trim();
  const modelReady = settings?.modelState.downloadState === "ready";
  const pendingJob = appState.pendingYoutubeJob;
  const queued = Boolean(pendingJob);
  const helperText = errorMessage ?? (pendingJob ? pendingJob.title ?? pendingJob.url ?? he.youtubeQueuedHint : null);

  // The cancel button leaves with the queued job, so focus has to land somewhere that stays.
  useLayoutEffect(() => {
    if (queued || !returnAfterCancel.current) return;
    returnAfterCancel.current = false;
    inputRef.current?.focus();
  }, [queued]);

  const clearEntry = () => {
    setUrl(""); setErrorMessage(null);
    inputRef.current?.focus();
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitPending.current || !modelReady) return;
    const parsed = youtubeSubmitInputSchema.safeParse({ url: trimmedUrl });
    if (!parsed.success) {
      setErrorMessage(parsed.error.issues[0]?.message ?? he.youtubeInvalidUrl);
      inputRef.current?.focus();
      return;
    }
    setErrorMessage(null);
    submitPending.current = true;
    setIsSubmitting(true);
    try {
      await submitYouTubeUrl(parsed.data.url);
      setUrl(current => current.trim() === trimmedUrl ? "" : current);
    } catch (error) {
      setErrorMessage(getHebrewErrorMessage(error, he.youtubeImportFailed));
    } finally {
      submitPending.current = false;
      setIsSubmitting(false);
    }
  };

  const onCancelPending = async () => {
    if (cancelPending.current) return;
    cancelPending.current = true;
    setIsCancelling(true);
    setErrorMessage(null);
    returnAfterCancel.current = true;
    try {
      await cancelPendingYouTube();
    } catch (error) {
      returnAfterCancel.current = false;
      setErrorMessage(getHebrewErrorMessage(error, "ביטול ההמתנה לא הושלם. אפשר לנסות שוב."));
    } finally {
      cancelPending.current = false;
      setIsCancelling(false);
    }
  };

  return <div className="youtube-cell">
    <form onSubmit={onSubmit} className="youtube-form app-no-drag">
      <div className="source-head"><span className="source-icon"><LinkSimple /></span><span className="source-title"><strong>{he.youtubeLabel}</strong><span>{he.youtubeHint}</span></span><SupportedSitesInfo /></div>
      <label htmlFor={inputId} className="sr-only">{he.youtubeUrlPlaceholder}</label>
      <div className="youtube-entry">
        <Input id={inputId} ref={inputRef} value={url} dir="ltr" inputMode="url" placeholder={he.youtubeUrlPlaceholder}
          disabled={!modelReady} aria-invalid={Boolean(errorMessage)} aria-describedby={helperText ? helperId : undefined}
          onChange={(event) => { setUrl(event.target.value); if (errorMessage) setErrorMessage(null); }}
          onKeyDown={(event) => { if (event.key === "Escape" && url) { event.preventDefault(); event.stopPropagation(); clearEntry(); } }} />
        <Button type="submit" variant="ghost" size="icon-xs" aria-label={isSubmitting ? he.visualizerAnalyzing : he.youtubeSubmit} title={he.youtubeSubmit} disabled={isSubmitting || !trimmedUrl || !modelReady} focusableWhenDisabled><ArrowLeft /></Button>
        {url && <Button type="button" variant="ghost" size="icon-xs" aria-label={he.clear} title={he.clear} onClick={clearEntry}><X /></Button>}
      </div>
      {helperText && <p id={helperId} className="youtube-helper" title={helperText} role={errorMessage ? "alert" : "status"} aria-live={errorMessage ? "assertive" : "polite"} aria-atomic="true">{helperText}</p>}
      {pendingJob && <div className="youtube-queue"><span>{he.youtubeQueued}</span><Button type="button" variant="ghost" size="sm" disabled={isCancelling} focusableWhenDisabled onClick={() => void onCancelPending()}>{he.youtubeCancelPending}</Button></div>}
    </form>
  </div>;
}
