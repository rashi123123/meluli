// os: home and temporary folders, the platform and the few facts the app reports.
export const EOL = "\n";
export function homedir(): string { return process.env.HOME || "/"; }
export function tmpdir(): string {
  const dir = process.env.TMPDIR || "/tmp";
  return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}
export function platform() { return "darwin"; }
export function type() { return "Darwin"; }
export function arch() { return process.arch; }
export function release() { return ""; }
export function hostname() { return "localhost"; }
export function cpus() { return Array.from({ length: 1 }, () => ({ model: "", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })); }
export function totalmem() { return 0; }
export function freemem() { return 0; }
export function userInfo() { return { username: process.env.USER ?? "", homedir: homedir(), shell: process.env.SHELL ?? null, uid: -1, gid: -1 }; }
/** Empty: nothing in the app maps signal names to numbers, and the host reports signals by name. */
export const constants = { signals: {} as Record<string, number> };
export default { EOL, homedir, tmpdir, platform, type, arch, release, hostname, cpus, totalmem, freemem, userInfo, constants };
