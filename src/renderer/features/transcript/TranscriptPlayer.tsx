import type { CSSProperties, KeyboardEvent } from "react";
import { Pause, Play } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/format";
import { he } from "@shared/locale";
import type { TranscriptPlayback } from "@/hooks/use-transcript-playback";

const clock = (seconds: number) => formatDurationMs(seconds * 1000);

/**
 * One recessed capsule: play, a bar to drag or click, the time and the speed.
 * Media runs left to right in every language, so the capsule does too.
 * Space plays or pauses anywhere inside it; on the bar, the arrow keys move through the recording.
 */
export function TranscriptPlayer({ playback }: { playback: TranscriptPlayback }) {
  if (playback.status === "none") return null;
  if (playback.status === "missing") return <p className="transcript-edit-note">{he.recordingGone}</p>;
  const ready = playback.status === "ready";
  const duration = playback.duration;
  const played = duration > 0 ? Math.min(100, (playback.time / duration) * 100) : 0;
  const space = (event: KeyboardEvent) => {
    if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (event.type === "keydown" && !event.repeat) playback.toggle();
  };
  return <div className="transcript-player" role="group" aria-label={he.playbackLabel} dir="ltr" onKeyDown={space} onKeyUp={space}>
    <audio {...playback.audioProps} />
    <Button className="transcript-player-toggle" size="icon-sm" variant="secondary" disabled={!ready} focusableWhenDisabled
      aria-label={playback.playing ? he.playbackPause : he.playbackPlay} onClick={playback.toggle}>
      {playback.playing ? <Pause /> : <Play />}
    </Button>
    <input className="transcript-player-seek" type="range" min={0} max={duration || 0} step="any" value={Math.min(playback.time, duration || 0)}
      disabled={!ready || duration <= 0} aria-label={he.playbackPosition}
      aria-valuetext={`${clock(playback.time)} ${he.playbackOf} ${clock(duration)}`}
      style={{ "--played": `${played}%` } as CSSProperties}
      onChange={(event) => playback.seek(Number(event.currentTarget.value))} />
    <span className="transcript-player-time">{clock(playback.time)} / {clock(duration)}</span>
    <Button className="transcript-player-rate" size="sm" variant="ghost" disabled={!ready} focusableWhenDisabled
      aria-label={`${he.playbackSpeed} ${playback.rate}×`} onClick={playback.cycleRate}>{playback.rate}×</Button>
  </div>;
}
