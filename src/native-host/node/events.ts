// Node's EventEmitter, as far as the main-process code and the shims use it.
type Listener = (...args: any[]) => void;

export class EventEmitter {
  static defaultMaxListeners = 10;
  private _events = new Map<string | symbol, Listener[]>();
  private _maxListeners = EventEmitter.defaultMaxListeners;

  on(event: string | symbol, listener: Listener): this { return this.addListener(event, listener); }
  addListener(event: string | symbol, listener: Listener): this {
    if (this._events.has("newListener") && event !== "newListener") this.emit("newListener", event, listener);
    const list = this._events.get(event) ?? [];
    list.push(listener);
    this._events.set(event, list);
    return this;
  }
  prependListener(event: string | symbol, listener: Listener): this {
    const list = this._events.get(event) ?? [];
    list.unshift(listener);
    this._events.set(event, list);
    return this;
  }
  once(event: string | symbol, listener: Listener): this {
    const wrapper = Object.assign((...args: any[]) => { this.removeListener(event, wrapper); listener.apply(this, args); }, { listener });
    return this.on(event, wrapper);
  }
  prependOnceListener(event: string | symbol, listener: Listener): this {
    const wrapper = Object.assign((...args: any[]) => { this.removeListener(event, wrapper); listener.apply(this, args); }, { listener });
    return this.prependListener(event, wrapper);
  }
  off(event: string | symbol, listener: Listener): this { return this.removeListener(event, listener); }
  removeListener(event: string | symbol, listener: Listener): this {
    const list = this._events.get(event);
    if (!list) return this;
    const index = list.findLastIndex((item) => item === listener || (item as { listener?: Listener }).listener === listener);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this._events.delete(event);
    if (index >= 0 && this._events.has("removeListener")) this.emit("removeListener", event, listener);
    return this;
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this._events.clear(); else this._events.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: any[]): boolean {
    const list = this._events.get(event);
    if (!list || list.length === 0) {
      if (event === "error") {
        const error = args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${String(args[0])})`);
        throw error;
      }
      return false;
    }
    for (const listener of [...list]) listener.apply(this, args);
    return true;
  }
  listenerCount(event: string | symbol): number { return this._events.get(event)?.length ?? 0; }
  listeners(event: string | symbol): Listener[] { return (this._events.get(event) ?? []).map((item) => (item as { listener?: Listener }).listener ?? item); }
  rawListeners(event: string | symbol): Listener[] { return [...(this._events.get(event) ?? [])]; }
  eventNames(): (string | symbol)[] { return [...this._events.keys()]; }
  setMaxListeners(count: number): this { this._maxListeners = count; return this; }
  getMaxListeners(): number { return this._maxListeners; }
}

export function once(emitter: EventEmitter, event: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => { emitter.removeListener(event, onEvent); reject(error); };
    const onEvent = (...args: any[]) => { if (event !== "error") emitter.removeListener("error", onError); resolve(args); };
    emitter.once(event, onEvent);
    if (event !== "error") emitter.once("error", onError);
  });
}

export default EventEmitter;
Object.assign(EventEmitter, { EventEmitter, once });
