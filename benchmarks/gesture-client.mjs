import { createGestureTrace } from './gesture-trace.mjs';
import { fixture, expectedSemantics, projectedSemantics } from './fixtures.mjs';
import { presetOptions } from './presets.mjs';
const root = document.querySelector('#editor'), inner = document.querySelector('#inner'), outer = document.querySelector('#outer');
const trace = createGestureTrace(); globalThis.__editacGesture = trace;
globalThis.__gestureScroll = () => ({ inner: inner.scrollTop, outer: outer.scrollTop });
let editor, storageName, baseline, expectedStart, expectedEnd;
const endpoints = []; let lastMouse, endpointDropped = 0;
function point(node, offset) {
  if (!node || !root.contains(node)) return null;
  const path = []; for (let n = node; n !== root; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
  return { path, offset, nodeType: node.nodeType, block: node.parentElement.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null };
}
function nativeHit(x, y) { const hit = document.caretPositionFromPoint(x, y); return hit ? point(hit.offsetNode, hit.offset) : null; }
for (const type of ['mousedown', 'mousemove', 'mouseup']) document.addEventListener(type, event => {
  lastMouse = { type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, hit: nativeHit(event.clientX, event.clientY), selection: selection() };
  if (trace.active) { if (endpoints.length < 2048) endpoints.push(lastMouse); else endpointDropped++; }
}, true);
const check = (ok, message) => { if (!ok) throw Error(message); };
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'selectionchange', 'dragstart', 'dragover', 'dragend', 'drop', 'keydown', 'scroll']) {
  document.addEventListener(type, event => trace.event(event), true);
}
for (const prototype of [Element.prototype, Range.prototype]) {
  for (const method of ['getBoundingClientRect', 'getClientRects']) {
    const original = prototype[method];
    prototype[method] = function(...args) { trace.note('geometry'); return original.apply(this, args); };
  }
}
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
export async function frames(count) { for (let i = 0; i < count; i++) await frame(); }
export async function prepare(name, preset, frozen) {
  const sdk = await import('./sdk.js'); await sdk.init('/fixture/wasm/editac_wasm_bg.wasm');
  storageName = `gesture-${crypto.randomUUID()}`;
  const storage = await sdk.CheckpointStorage.open(indexedDB, storageName);
  try { await storage.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); }
  finally { storage.close(); }
  editor = sdk.createEditor(root, { assetUrl: '/fixture/wasm/editac_wasm_bg.wasm', databaseName: storageName,
    identity: frozen.identity, indexedDB, locks: navigator.locks, ...presetOptions(preset, sdk) });
  await editor.ready;
  baseline = JSON.stringify(projectedSemantics(editor.read()));
  check(baseline === JSON.stringify(expectedSemantics(fixture(name))), 'Retained fixture semantics mismatch');
  check(PerformanceObserver.supportedEntryTypes.includes('longtask'), 'Long-task observer unavailable');
  const timestamps = [];
  for (let i = 0; i < 32; i++) { await frame(); timestamps.push(performance.now()); }
  return { chars: fixture(name).chars, blocks: fixture(name).blocks.length, refreshTimestamps: timestamps,
    semantics: baseline, runtime: navigator.userAgent, devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
}
function firstText(container = root) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const word = /[A-Za-z]{8,}/.exec(node.data);
    if (word && !node.parentElement.closest('[contenteditable="false"]')) return { text: node, at: word.index, length: word[0].length };
  }
  throw Error('No editable text');
}
function coordinate(text, offset) {
  const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
  for (const rect of range.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    // MouseEvent client coordinates are integral. A fractional glyph midpoint
    // can hit the opposite caret once dispatched. Choose an integer pixel
    // strictly inside the glyph whose independent native hit is exactly offset.
    const y = Math.round(rect.y + rect.height / 2);
    for (let x = Math.ceil(rect.left); x < rect.right; x++) {
      const hit = document.caretPositionFromPoint(x, y);
      if (hit?.offsetNode === text && hit.offset === offset)
        return { x, y, glyphWidth: rect.width, offset, nativeOffset: hit.offset, endpoint: point(text, offset),
          fractionalControl: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
            hit: nativeHit(rect.x + rect.width / 2, rect.y + rect.height / 2),
            dispatchedHit: nativeHit(Math.floor(rect.x + rect.width / 2), Math.floor(rect.y + rect.height / 2)) } };
    }
  }
  throw Error('No integral pixel hits the exact intended UTF-16 caret');
}
function visibleText(code = false) {
  const rect = inner.getBoundingClientRect();
  for (let y = rect.top + 30; y < rect.bottom - 30; y += 24) {
    for (let x = rect.left + 50; x < rect.left + 400; x += 150) {
      const hit = document.caretPositionFromPoint(x, y), text = hit?.offsetNode;
      if (text?.nodeType !== Node.TEXT_NODE || !root.contains(text) || text.parentElement.closest('[contenteditable="false"]') || !!text.parentElement.closest('pre') !== code) continue;
      for (const word of text.data.matchAll(/[A-Za-z]{8,}/g)) {
        if (word.index < hit.offset || word.index > hit.offset + 80) continue;
        let point; try { point = coordinate(text, word.index + 2); } catch { continue; }
        if (point.y > rect.top + 10 && point.y < rect.bottom - 30 && point.x > rect.left && point.x < rect.right)
          return { text, at: word.index, length: word[0].length };
      }
    }
  }
  throw Error('No visible editable autoscroll start');
}
export async function setup(kind) {
  outer.scrollTop = 0; inner.scrollTop = 0; document.getSelection().removeAllRanges(); root.focus();
  await frames(3);
  // Exercise transfer at a real nested scroll boundary in both full corpora.
  // Positioning is outside measurement; no document blocks/text are removed.
  if (kind.startsWith('autoscroll')) { inner.scrollTop = Math.max(0, inner.scrollHeight - inner.clientHeight - 320); await frames(3); }
  if (kind === 'autoscroll-code') {
    const block = [...root.querySelectorAll('pre')].at(-1); check(block, 'No code block');
    block.scrollIntoView({ block: 'center' }); outer.scrollTop = 0; await frames(3);
  }
  const { text, at, length } = kind === 'autoscroll-code' ? firstText([...root.querySelectorAll('pre')].at(-1))
    : kind === 'autoscroll' ? visibleText() : firstText();
  // Deliberately exercise the narrowest interior glyph, including code starts.
  const candidates = Array.from({ length: Math.floor(length / 2) - 1 }, (_, i) => {
    try { return coordinate(text, at + i + 1); } catch { return null; }
  }).filter(Boolean);
  check(candidates.length, 'No native-verified interior character rectangle');
  const start = candidates.sort((a, b) => a.glyphWidth - b.glyphWidth)[0], end = coordinate(text, at + length - 1);
  // A focused editing host with Selection.type=None is not a normal pointer
  // starting state in Chromium. Establish only a collapsed caret; the trusted
  // mouse must produce the range and scrolling during the measured window.
  document.getSelection().setBaseAndExtent(text, start.offset, text, start.offset); await frames(3);
  expectedStart = { node: text, offset: start.offset }; expectedEnd = { node: text, offset: end.offset };
  let dragPoint;
  if (kind === 'drag') {
    document.getSelection().setBaseAndExtent(text, at, text, at + length); await frames(3);
    // Whitespace/line-break glyphs can have empty or misleading rectangles.
    // Require native hit testing to land strictly inside the selected text.
    for (let offset = at + 1; offset < at + length - 1; offset++) {
      const p = coordinate(text, offset), hit = document.caretPositionFromPoint(p.x, p.y);
      if (hit?.offsetNode === text && hit.offset > at && hit.offset < at + length) { dragPoint = p; break; }
    }
    check(dragPoint, 'No visible selected-text drag point');
  }
  const innerRect = inner.getBoundingClientRect(), outerRect = outer.getBoundingClientRect();
  return { start: kind === 'drag' ? dragPoint : start, end,
    innerEdge: { x: start.x, y: innerRect.bottom - 2 }, outerEdge: { x: start.x, y: outerRect.bottom + 16 },
    initialSelection: selection(), initialScroll: scroll() };
}
function selection() {
  const s = document.getSelection(); return { anchorOffset: s.anchorOffset, focusOffset: s.focusOffset,
    anchor: point(s.anchorNode, s.anchorOffset), focus: point(s.focusNode, s.focusOffset), collapsed: s.isCollapsed, length: s.toString().length, inside: root.contains(s.anchorNode) && root.contains(s.focusNode) };
}
function scroll() { return { inner: inner.scrollTop, outer: outer.scrollTop }; }
export function begin(kind) { endpoints.length = 0; endpointDropped = 0; trace.begin(kind); }
export function endpoint() {
  const s = document.getSelection();
  const range = document.createRange(); range.setStart(expectedStart.node, expectedStart.offset);
  let expectedLength = null;
  try { range.setEnd(expectedEnd.node, expectedEnd.offset); expectedLength = range.toString().length; } catch {}
  return { selection: selection(), lastMouse, anchorMatches: s.anchorNode === expectedStart.node && s.anchorOffset === expectedStart.offset,
    focusMatches: s.focusNode === expectedEnd.node && s.focusOffset === expectedEnd.offset, expectedLength };
}
export function state() { return { selection: selection(), scroll: scroll() }; }
export async function finish() {
  const endState = state(), observations = trace.end();
  await frames(12); const settled = state(); await frames(12); const afterCancel = state();
  const unchanged = baseline === JSON.stringify(projectedSemantics(editor.read()));
  return { ...observations, nativeEndpoints: [...endpoints], endpointDropped, endpointOracle: endpoint(), endState, settled, afterCancel, unchanged, collectorActive: trace.active };
}
export async function destroy() {
  if (trace.active) trace.end();
  await editor?.destroy({ policy: 'flush' }); editor = undefined;
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(storageName);
    request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Database teardown blocked')); });
  return { editable: root.contentEditable, traceActive: trace.active };
}
