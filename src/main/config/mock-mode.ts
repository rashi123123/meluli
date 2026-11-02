/** Read at each call: the packaged app deletes both variables as it loads. */
export function isMockMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IVRIT_E2E_MOCK === "1" || env.IVRIT_USE_MOCK_SERVICES === "1";
}
