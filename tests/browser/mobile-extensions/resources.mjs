// Observe allocation stacks from the actual packaged optional implementations.
// Existing mobileResources separately counts required BrowserEditor/Session work.
export function installExtensionCounters() {
  const optional = /\/web\/(?:modules\/(?:slash|references|reorder|search|content|code|images|embeds|assets|formats)|extensions\/(?:runtime|authoring|matching|spelling|code|math))/;
  const owned = [], listeners = [];
  const owner = () => new Error().stack?.split('\n').find(line => optional.test(line))?.trim();
  const record = kind => { const source = owner(); if (source) owned.push({ kind, source }); };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
  EventTarget.prototype.addEventListener = function(type, callback, options) {
    const source = owner();
    if (source && callback && !listeners.some(r => r.target === this && r.type === type && r.callback === callback && r.capture === capture(options)))
      listeners.push({ target: this, type, callback, capture: capture(options), source });
    return add.call(this, type, callback, options);
  };
  EventTarget.prototype.removeEventListener = function(type, callback, options) {
    const at = listeners.findIndex(r => r.target === this && r.type === type && r.callback === callback && r.capture === capture(options));
    if (at >= 0) listeners.splice(at, 1);
    return remove.call(this, type, callback, options);
  };
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Worker', 'SharedWorker', 'WebSocket']) {
    const Original = window[name]; if (!Original) continue;
    window[name] = class extends Original { constructor(...args) { record(name); super(...args); } };
  }
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'fetch']) {
    const original = window[name]; window[name] = function(...args) { record(name); return original.apply(this, args); };
  }
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) { record('XMLHttpRequest'); return send.apply(this, args); };
  window.mobileExtensionResources = () => ({ listeners: listeners.length, allocations: owned.slice() });
}
