// The environment Meluli gives its helper processes. Each helper sees only a fixed PATH and the few variables
// that locate the user's home, temporary folder and language; anything else (DYLD_*, GGML_BACKEND_PATH,
// OPENSSL_CONF, extra PATH entries) could load code into a process that sees what the user dictates or imports.
const PASSED_THROUGH = ["HOME", "TMPDIR", "LANG"] as const;

export function minimalChildEnv(source: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ...extra };
  for (const key of PASSED_THROUGH) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
