// Diagnostic CDP evidence only. Never retain trace args, stacks, URLs or text.
import { captureLayoutRoots, layoutEventData } from './loading-layout-roots.mjs';
export const renderEvents = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize'];
const finite = v => Number.isFinite(v) && v >= 0;
const check = (ok, reason) => { if (!ok) throw Error(`Invalid rendering attribution: ${reason}`); };
export function inspectRenderTrace(trace, raw) {
  check(trace?.version === 'cdp-rendering-v1' && Object.keys(trace).sort().join() === 'events,version,windowMs', 'identity/payload');
  check(finite(trace.windowMs) && trace.windowMs === raw.samples.firstFrameMs && trace.windowMs > 0, 'window');
  check(Array.isArray(trace.events) && trace.events.length > 0 && trace.events.length <= 4096, 'missing/overflow events');
  let previous = 0;
  for (const event of trace.events) {
    check(Object.keys(event).sort().join() === 'durationMs,name,startMs', 'event payload');
    check(renderEvents.includes(event.name) && finite(event.startMs) && finite(event.durationMs), 'event/clock');
    check(event.startMs >= previous && event.startMs < trace.windowMs && event.durationMs <= trace.windowMs - event.startMs + 1, 'ordering/window');
    previous = event.startMs;
  }
  check(trace.events.some(e => e.name === 'Layout') && trace.events.some(e => e.name === 'Paint'), 'missing layout/paint');
  return renderEvents.map(name => {
    const events = trace.events.filter(e => e.name === name);
    return { name, count: events.length, durationMs: events.reduce((n, e) => n + e.durationMs, 0), maxMs: Math.max(0, ...events.map(e => e.durationMs)) };
  });
}
export async function startRenderTrace(cdp, { layoutRoots = false } = {}) {
  const events = [], threads = new Set(); let overflow = false, layoutError;
  const collect = ({ value }) => {
    for (const event of value) {
      if (event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain') threads.add(`${event.pid}/${event.tid}`);
      if (event.ph !== 'X' || !renderEvents.includes(event.name)) continue;
      if (events.length === 4096) { overflow = true; continue; }
      let layout;
      if (layoutRoots && event.name === 'Layout') { try { layout = layoutEventData(event.args); } catch (error) { layoutError = error; } }
      events.push({ thread: `${event.pid}/${event.tid}`, name: event.name, start: event.ts, duration: event.dur, ...(layoutRoots && event.name === 'Layout' ? { layout } : {}) });
    }
  };
  cdp.on('Tracing.dataCollected', collect);
  try { await cdp.send('Tracing.start', { categories: 'devtools.timeline', options: 'record-as-much-as-possible', transferMode: 'ReportEvents' }); }
  catch (error) { cdp.off('Tracing.dataCollected', collect); throw error; }
  return async raw => {
    let timer;
    const complete = new Promise((ok, fail) => { cdp.once('Tracing.tracingComplete', ok); timer = setTimeout(() => fail(Error('Rendering trace completion deadline')), 10000); });
    try {
      const metrics = await cdp.send('Performance.getMetrics');
      const origin = metrics.metrics.find(m => m.name === 'NavigationStart')?.value;
      await cdp.send('Tracing.end'); await complete;
      check(!overflow, 'trace overflow'); check(finite(origin) && origin > 0 && threads.size > 0, 'navigation/thread clock');
      const trace = { version: 'cdp-rendering-v1', windowMs: raw.samples.firstFrameMs, events: events
        .filter(e => threads.has(e.thread))
        .map(e => ({ name: e.name, startMs: e.start / 1000 - origin * 1000, durationMs: e.duration / 1000 }))
        .filter(e => e.startMs >= 0 && e.startMs < raw.samples.firstFrameMs)
        .sort((a, b) => a.startMs - b.startMs) };
      inspectRenderTrace(trace, raw);
      if (layoutRoots) {
        if (layoutError) throw layoutError;
        const layouts = events.filter(e => threads.has(e.thread) && e.name === 'Layout')
          .map(e => ({ startMs: e.start / 1000 - origin * 1000, durationMs: e.duration / 1000, ...e.layout }))
          .filter(e => e.startMs >= 0 && e.startMs < raw.samples.firstFrameMs).sort((a, b) => a.startMs - b.startMs);
        // Resolve after all timed work. This is root scope, never per-descendant cost.
        raw.layoutRoots = await captureLayoutRoots(cdp, layouts, raw.samples.firstFrameMs);
      }
      return trace;
    } finally { clearTimeout(timer); cdp.off('Tracing.dataCollected', collect); }
  };
}
