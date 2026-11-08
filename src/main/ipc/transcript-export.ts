import { join } from "node:path";
import { BrowserWindow, dialog, Menu } from "electron";
import { he } from "@shared/locale";
import type { TranscriptExportFormat, TranscriptRecord } from "@shared/types";
import {
  buildTranscriptExport,
  buildTranscriptFileName,
  transcriptExportFormats,
  writeTranscriptFile
} from "../services/subtitle-export.service";

const EXPORT_LABELS: Record<TranscriptExportFormat, string> = {
  md: he.exportMarkdown,
  vtt: he.exportVtt,
  srt: he.downloadSrt
};

/**
 * Export one transcript: pick a format (a menu under the button when there is more than one),
 * then a save dialog that opens in the transcripts folder. False when nothing was written.
 */
export async function exportTranscript(
  transcript: TranscriptRecord,
  window: BrowserWindow | null,
  anchor: { x: number; y: number } | undefined,
  transcriptsDir: string
): Promise<boolean> {
  const formats = transcriptExportFormats(transcript);
  const format = window && formats.length > 1 ? await chooseExportFormat(window, formats, anchor) : formats[0]!;
  if (!format) return false;
  const content = buildTranscriptExport(transcript, format);
  if (!content) return false;
  const result = await dialog.showSaveDialog({
    defaultPath: join(transcriptsDir, buildTranscriptFileName(transcript, format)),
    filters: [{ name: EXPORT_LABELS[format], extensions: [format] }]
  });
  if (result.canceled || !result.filePath) return false;
  await writeTranscriptFile(result.filePath, content);
  return true;
}

/**
 * A native menu under the export button. macOS can report the close before the click,
 * so a close waits a moment for a choice before it counts as dismissed.
 */
function chooseExportFormat(window: BrowserWindow, formats: TranscriptExportFormat[], anchor?: { x: number; y: number }): Promise<TranscriptExportFormat | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (format: TranscriptExportFormat | null) => { if (!settled) { settled = true; resolve(format); } };
    const menu = Menu.buildFromTemplate(formats.map((format) => ({ label: EXPORT_LABELS[format], click: () => finish(format) })));
    menu.popup({ window, ...(anchor ?? {}), callback: () => setTimeout(() => finish(null), 250) });
  });
}
