// module.createRequire: the database code loads better-sqlite3 this way; the bundle maps it to the
// host's SQLite binding.
import Database from "../sqlite";

const modules: Record<string, unknown> = { "better-sqlite3": Database };
export function createRequire(_from: string) {
  const require = (name: string) => {
    if (name in modules) return modules[name];
    throw Object.assign(new Error(`Cannot find module '${name}'`), { code: "MODULE_NOT_FOUND" });
  };
  require.resolve = (name: string) => name;
  return require;
}
export const builtinModules: string[] = [];
export default { createRequire, builtinModules };
