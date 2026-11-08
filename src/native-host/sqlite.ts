// better-sqlite3's API over the host's SQLite (HostSQLite.swift): the same synchronous calls, so the
// repositories and migrations run unchanged. Statements are finalized when collected or on close.
type Params = unknown[];

const statements = new FinalizationRegistry<number>((id) => { try { __native.sqliteFinalize(id); } catch { /* closed */ } });

function sqliteError(error: unknown): never {
  if (error instanceof Error) {
    const copy = Object.assign(new Error(error.message), { code: (error as { code?: string }).code ?? "SQLITE_ERROR" });
    copy.name = "SqliteError";
    throw copy;
  }
  throw error;
}

export class Statement {
  readonly reader: boolean;
  readonly readonly: boolean;
  private readonly id: number;
  private plucking = false;
  constructor(readonly database: Database, readonly source: string) {
    try {
      const prepared = __native.sqlitePrepare(database._id(), source);
      this.id = prepared.id;
      this.reader = prepared.reader;
      this.readonly = prepared.readonly;
    } catch (error) { sqliteError(error); }
    statements.register(this, this.id);
  }
  private step(params: Params, mode: "run" | "get" | "all" | "pluck") {
    this.database._check();
    try { return __native.sqliteStep(this.id, params, mode); } catch (error) { sqliteError(error); }
  }
  private requireReader() { if (!this.reader) throw new TypeError("This statement does not return data. Use run() instead"); }
  run(...params: Params): { changes: number; lastInsertRowid: number } {
    const { changes, lastInsertRowid } = this.step(params, "run");
    return { changes, lastInsertRowid };
  }
  get(...params: Params): unknown {
    this.requireReader();
    if (this.plucking) { const rows = this.step(params, "pluck") as unknown[]; return rows[0]; }
    return this.step(params, "get");
  }
  all(...params: Params): unknown[] { this.requireReader(); return this.step(params, this.plucking ? "pluck" : "all"); }
  *iterate(...params: Params): IterableIterator<unknown> { yield* this.all(...params); }
  pluck(toggle = true): this { this.plucking = toggle; return this; }
  raw(): never { throw new Error("Statement.raw is not available in the native host"); }
  expand(): never { throw new Error("Statement.expand is not available in the native host"); }
  bind(): never { throw new Error("Statement.bind is not available in the native host"); }
}

export default class Database {
  readonly name: string;
  readonly memory: boolean;
  readonly readonly: boolean;
  open = true;
  private readonly handle: number;
  private depth = 0;

  constructor(path = ":memory:", options: { readonly?: boolean; fileMustExist?: boolean; timeout?: number } = {}) {
    this.name = path;
    this.memory = path === ":memory:" || path === "";
    this.readonly = Boolean(options.readonly);
    if (options.fileMustExist && !this.memory && !__native.fsSync("exists", [path], null)) {
      throw Object.assign(new TypeError(`Cannot open database because the directory does not exist`), { code: "SQLITE_CANTOPEN" });
    }
    try { this.handle = __native.sqliteOpen(path || ":memory:", this.readonly); } catch (error) { sqliteError(error); }
  }
  /** @internal */ _id() { this._check(); return this.handle; }
  /** @internal */ _check() { if (!this.open) throw new TypeError("The database connection is not open"); }

  get inTransaction(): boolean { return this.open && __native.sqliteInTransaction(this.handle); }

  prepare(source: string): Statement { return new Statement(this, source); }
  exec(source: string): this {
    this._check();
    try { __native.sqliteExec(this.handle, source); } catch (error) { sqliteError(error); }
    return this;
  }
  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const statement = this.prepare(`PRAGMA ${source}`);
    if (!statement.reader) { statement.run(); return options.simple ? undefined : []; }
    return options.simple ? statement.pluck().get() : statement.all();
  }
  transaction<T extends (...args: any[]) => any>(fn: T): T & { deferred: T; immediate: T; exclusive: T } {
    const wrap = (begin: string) => ((...args: unknown[]) => {
      const nested = this.depth > 0 || this.inTransaction;
      const savepoint = `meluli_${this.depth}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
      this.depth++;
      try {
        const result = fn(...args);
        if (result && typeof (result as { then?: unknown }).then === "function") throw new TypeError("Transaction function cannot return a promise");
        this.depth--;
        this.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.depth = Math.max(0, this.depth - 1);
        if (this.inTransaction) this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        throw error;
      }
    }) as T;
    const main = wrap("BEGIN") as T & { deferred: T; immediate: T; exclusive: T };
    main.deferred = main;
    main.immediate = wrap("BEGIN IMMEDIATE");
    main.exclusive = wrap("BEGIN EXCLUSIVE");
    return main;
  }
  close(): this {
    if (this.open) { this.open = false; __native.sqliteClose(this.handle); }
    return this;
  }
  function(): never { throw new Error("Database.function is not available in the native host"); }
  aggregate(): never { throw new Error("Database.aggregate is not available in the native host"); }
  backup(): never { throw new Error("Database.backup is not available in the native host; use VACUUM INTO"); }
  loadExtension(): never { throw new Error("Extensions are not loaded in the native host"); }
  defaultSafeIntegers(): this { return this; }
  unsafeMode(): this { return this; }
}
export { Database };
