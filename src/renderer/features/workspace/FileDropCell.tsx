import { useState, type DragEvent } from "react";
import { DownloadSimple, FolderOpen } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { he } from "@shared/locale";

const carriesFile = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** The file cell: click to choose, or drop a file onto its dashed edge. */
export function FileDropCell({ disabled, onPick, onDropFile }: { disabled: boolean; onPick: () => void; onDropFile: (file: File) => void }) {
  const [dropping, setDropping] = useState(false);
  const accept = (event: DragEvent) => {
    if (!carriesFile(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (!disabled) setDropping(true);
  };
  return <Button type="button" variant="plain" className="cell quick-action app-no-drag" data-dropping={dropping || undefined} aria-label={he.importAudio} onClick={onPick} disabled={disabled} focusableWhenDisabled
    onDragEnter={accept} onDragOver={accept}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
    onDrop={(event) => {
      event.preventDefault();
      setDropping(false);
      const file = event.dataTransfer.files[0];
      if (file && !disabled) onDropFile(file);
    }}>
    <span className="source-head"><span className="source-icon">{dropping ? <DownloadSimple /> : <FolderOpen />}</span>
      <span className="source-title"><strong>{dropping ? he.importAudioDrop : he.importAudioCompact}</strong>{!dropping && <span>{he.importAudioHint}</span>}</span></span>
  </Button>;
}
