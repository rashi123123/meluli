// Event, EventTarget, AbortController and AbortSignal, enough for fetch, timeouts and the SDKs.
export class DOMException extends Error {
  static readonly ABORT_ERR = 20;
  static readonly TIMEOUT_ERR = 23;
  readonly code: number;
  constructor(message = "", name = "Error") {
    super(message);
    Object.defineProperty(this, "name", { value: name, configurable: true, writable: true });
    this.code = name === "AbortError" ? 20 : name === "TimeoutError" ? 23 : 0;
  }
}

/** What an abort without a reason reports, as the web platform does. */
export const abortedReason = (): DOMException => new DOMException("This operation was aborted", "AbortError");

export class Event {
  readonly type: string;
  defaultPrevented = false;
  target: unknown = null;
  currentTarget: unknown = null;
  readonly timeStamp = Date.now();
  constructor(type: string, readonly init: { cancelable?: boolean } = {}) { this.type = type; }
  preventDefault() { if (this.init.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() {}
}

type Handler = ((event: Event) => void) | { handleEvent(event: Event): void };

export class EventTarget {
  private listeners = new Map<string, { handler: Handler; once: boolean }[]>();
  addEventListener(type: string, handler: Handler | null, options?: boolean | { once?: boolean; signal?: AbortSignal }) {
    if (!handler) return;
    const list = this.listeners.get(type) ?? [];
    if (list.some((entry) => entry.handler === handler)) return;
    const once = typeof options === "object" && Boolean(options.once);
    list.push({ handler, once });
    this.listeners.set(type, list);
    if (typeof options === "object" && options.signal) options.signal.addEventListener("abort", () => this.removeEventListener(type, handler), { once: true });
  }
  removeEventListener(type: string, handler: Handler | null) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.findIndex((entry) => entry.handler === handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event: Event): boolean {
    event.target = this;
    event.currentTarget = this;
    const property = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof property === "function") property.call(this, event);
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.handler);
      try {
        if (typeof entry.handler === "function") entry.handler.call(this, event); else entry.handler.handleEvent(event);
      } catch (error) { setTimeout(() => { throw error; }, 0); }
    }
    return !event.defaultPrevented;
  }
}

export class AbortSignal extends EventTarget {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((event: Event) => void) | null = null;

  throwIfAborted() { if (this.aborted) throw this.reason; }

  /** @internal */
  _abort(reason: unknown) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason === undefined ? abortedReason() : reason;
    this.dispatchEvent(new Event("abort"));
  }

  static abort(reason?: unknown): AbortSignal { const signal = new AbortSignal(); signal._abort(reason); return signal; }
  static timeout(ms: number): AbortSignal {
    const signal = new AbortSignal();
    setTimeout(() => signal._abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return signal;
  }
  static any(signals: AbortSignal[]): AbortSignal {
    const combined = new AbortSignal();
    for (const signal of signals) {
      if (signal.aborted) { combined._abort(signal.reason); return combined; }
      signal.addEventListener("abort", () => combined._abort(signal.reason), { once: true });
    }
    return combined;
  }
}

export class AbortController {
  readonly signal = new AbortSignal();
  abort(reason?: unknown) { this.signal._abort(reason); }
}
