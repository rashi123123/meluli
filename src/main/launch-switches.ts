declare const __MELULI_ALLOW_DEBUG_SWITCHES__: boolean | undefined;

/**
 * Switches that hand the process, or its sandbox, to whoever launched it. Fuses do not
 * gate Chromium's. A list of what is refused, because macOS and Electron add their own.
 */
const REFUSED_SWITCHES = [
  /^remote-debugging/,
  /^remote-allow-origins$/,
  /^inspect/,
  /^debug-port$/,
  /^browser-subprocess-path$/,
  /-cmd-prefix$/,
  /-launcher$/,
  /^js-flags$/,
  /^no-sandbox$/,
  /^disable-.*sandbox/,
  /^no-zygote/,
  /^single-process$/,
  /^in-process-gpu$/,
  /^disable-web-security$/
];

/** Chromium also reads `-x`, and Node also reads `--x_y`, so both count as the same switch. */
export function findRefusedSwitch(argv: readonly string[]): string | null {
  for (const argument of argv) {
    const name = /^--?([^=]+)/.exec(argument)?.[1]?.toLowerCase().replaceAll("_", "-");
    if (name && REFUSED_SWITCHES.some((pattern) => pattern.test(name))) return name;
  }
  return null;
}

/** Decided when the bundle is built. Anything read at launch is the launcher's to set. */
export function debugSwitchesAllowed(): boolean {
  return typeof __MELULI_ALLOW_DEBUG_SWITCHES__ !== "undefined" && __MELULI_ALLOW_DEBUG_SWITCHES__ === true;
}

/** Diagnostics that write to the profile: on in development, and off in a shipped build. */
export function diagnosticsAllowed(isPackaged: boolean): boolean {
  return !isPackaged || debugSwitchesAllowed();
}

const DEVELOPMENT_ENV = [
  "ELECTRON_RENDERER_URL",
  "IVRIT_E2E_MOCK",
  "IVRIT_USE_MOCK_SERVICES",
  "MELULI_DICTATION_MODE",
  "MELULI_EXPERIMENT_ASSETS",
  "MELULI_EXPERIMENTAL_DICTATION",
  "MELULI_FINALIZE_OVERLAP",
  "MELULI_NATIVE_PASTE",
  "MELULI_OFFLINE_RESEARCH",
  "MELULI_PIPELINE_TRACE",
  "MELULI_RESERVE_DURING_FINALIZE"
];

/**
 * For a packaged app, before anything reads them. MELULI_USER_DATA stays, since packaged
 * tests rely on it: dropping it would put a test run on the user's real history.
 */
export function clearDevelopmentEnv(env: NodeJS.ProcessEnv): void {
  for (const name of DEVELOPMENT_ENV) delete env[name];
  if (!diagnosticsAllowed(true)) delete env.MELULI_DICTATION_TIMING;
}
