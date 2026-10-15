// Test-only instrumentation. Weak references avoid making the probe a retention root.
export function resourceProbe() {
  const listeners = [], observers = [], workers = [], timers = new Map(), frames = new Set();
  const native = { add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window) };
  let callbacks = 0, schedules = 0;
  const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
  EventTarget.prototype.addEventListener = function(type, fn, options) {
    if (!fn) return native.add.call(this, type, fn, options);
    const old = listeners.find(l => l.active && l.target.deref() === this && l.fn.deref() === fn && l.type === type && l.capture === capture(options));
    if (old) return;
    const entry = { target: new WeakRef(this), fn: new WeakRef(fn), type, capture: capture(options), active: !options?.signal?.aborted };
    const wrapped = options?.once ? function(event) { entry.active = false; return typeof fn === 'function' ? fn.call(this, event) : fn.handleEvent(event); } : fn;
    entry.wrapped = new WeakRef(wrapped); listeners.push(entry);
    if (options?.signal) native.add.call(options.signal, 'abort', () => { entry.active = false; }, { once: true });
    return native.add.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function(type, fn, options) {
    const entry = listeners.find(l => l.active && l.target.deref() === this && l.fn.deref() === fn && l.type === type && l.capture === capture(options));
    if (entry) { entry.active = false; return native.remove.call(this, type, entry.wrapped.deref(), options); }
    return native.remove.call(this, type, fn, options);
  };
  for (const [name, repeat] of [['setTimeout', false], ['setInterval', true]]) window[name] = (fn, ms, ...args) => {
    schedules++; const id = native[name](() => { if (!repeat) timers.delete(id); callbacks++; fn(...args); }, ms); timers.set(id, repeat); return id;
  };
  for (const name of ['clearTimeout', 'clearInterval']) window[name] = id => { timers.delete(id); native[name](id); };
  window.requestAnimationFrame = fn => { schedules++; const id = native.raf(time => { frames.delete(id); callbacks++; fn(time); }); frames.add(id); return id; };
  window.cancelAnimationFrame = id => { frames.delete(id); native.caf(id); };
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const Original = window[name]; if (!Original) continue;
    window[name] = class extends Original {
      constructor(fn) { const state = { active: false }; super((...args) => { callbacks++; fn(...args); }); state.ref = new WeakRef(this); observers.push(state); this.probeState = state; }
      observe(...args) { this.probeState.active = true; return super.observe(...args); }
      disconnect() { this.probeState.active = false; return super.disconnect(); }
    };
  }
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(...args) { super(...args); this.probeState = { ref: new WeakRef(this), active: true }; workers.push(this.probeState); }
    terminate() { this.probeState.active = false; return super.terminate(); }
  };
  return {
    snapshot: () => {
      for (let i = listeners.length - 1; i >= 0; i--) if (!listeners[i].active || !listeners[i].target.deref() || !listeners[i].fn.deref()) listeners.splice(i, 1);
      for (let i = observers.length - 1; i >= 0; i--) if (!observers[i].active || !observers[i].ref.deref()) observers.splice(i, 1);
      // A collected JS handle does not prove that a worker has terminated.
      for (let i = workers.length - 1; i >= 0; i--) if (!workers[i].active) workers.splice(i, 1);
      return { listeners: listeners.length, observers: observers.length, workers: workers.length,
        timers: timers.size, frames: frames.size, callbacks, schedules };
    },
    wait: ms => new Promise(resolve => native.setTimeout(resolve, ms)),
    frame: () => new Promise(resolve => native.raf(resolve)),
  };
}
