// Harness-only observer. rAF is a browser callback clock, not compositor proof.
export const gestureVersion = 'native-pointer-selection-drag-scroll-v1';
export function createGestureTrace(host = globalThis, capacity = 2048) {
  let active, request, observer;
  const append = (key, value) => {
    if (!active) return;
    if (active[key].length >= capacity) active.dropped++;
    else active[key].push(value);
  };
  const work = {};
  const reset = () => { for (const key of ['geometry', 'mapping', 'positions', 'fullScan', 'visitedPositions']) work[key] = 0; };
  reset();
  const frame = timestamp => {
    if (!active) return;
    append('frames', { timestamp, callbackTime: host.performance.now(), ...work, scroll: host.__gestureScroll?.() }); reset();
    request = host.requestAnimationFrame(frame);
  };
  return {
    note(key, count = 1) { if (active && Object.hasOwn(work, key)) work[key] += count; },
    event(event) { append('events', { type: event.type, timestamp: host.performance.now(), trusted: event.isTrusted,
      ...(event.type === 'dragend' ? { dropEffect: event.dataTransfer?.dropEffect } : {}) }); },
    begin(kind) {
      if (active) throw Error('Nested gesture trace');
      reset(); active = { version: gestureVersion, kind, start: host.performance.now(), capacity, dropped: 0, frames: [], longTasks: [], events: [] };
      observer = new host.PerformanceObserver(list => {
        for (const entry of list.getEntries()) append('longTasks', { start: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: 'longtask' });
      request = host.requestAnimationFrame(frame);
    },
    end() {
      if (!active) throw Error('Missing gesture trace');
      for (const entry of observer.takeRecords()) append('longTasks', { start: entry.startTime, duration: entry.duration });
      observer.disconnect(); observer = undefined;
      host.cancelAnimationFrame(request); request = undefined;
      const result = { ...active, end: host.performance.now(), trailingWork: { ...work }, observer: 'supported', pendingCollectorFrames: 0 };
      active = undefined; reset(); return result;
    },
    get active() { return !!active; },
  };
}
