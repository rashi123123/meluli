// The Darwin signal numbers the app's helpers are sent, by name and back.
export const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 30, SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTOP: 17, SIGCONT: 19 };
export const SIGNAL_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(SIGNAL_NUMBERS).map(([name, number]) => [number, name]));

/** Node's error for an aborted operation (fs, child_process), carrying the signal's reason. */
export function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
}
