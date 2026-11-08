function formatTotalSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

export function formatDurationMs(durationMs: number | null | undefined): string {
  if (!durationMs) {
    return "00:00";
  }

  return formatTotalSeconds(Math.floor(durationMs / 1000));
}

/** A saved transcript's length, without a leading zero so it reads apart from a clock time: 2:22, not 02:22. */
export function formatTranscriptDurationMs(durationMs: number | null | undefined): string {
  if (!durationMs) {
    return "0:00";
  }

  return formatTotalSeconds(Math.max(1, Math.round(durationMs / 1000))).replace(/^0(?=\d:)/, "");
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp);
}

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("he-IL", { timeStyle: "short" }).format(timestamp);
}

/** A short day name: today, yesterday, then the date itself. */
export function formatDay(timestamp: number, now = Date.now()): string {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const day = new Date(timestamp).setHours(0, 0, 0, 0);
  const daysAgo = Math.round((midnight - day) / 86_400_000);
  if (daysAgo === 0) return "היום";
  if (daysAgo === 1) return "אתמול";
  // This year goes without saying.
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat("he-IL", sameYear ? { day: "numeric", month: "short" } : { dateStyle: "medium" }).format(timestamp);
}
