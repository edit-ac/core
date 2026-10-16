// Test-only packed-browser diagnostic. Read DOM after timing; retain no text,
// attributes, URLs, document IDs or trace stacks. Backend IDs are navigation-local.
const check = (ok, why) => { if (!ok) throw Error(`Invalid layout roots: ${why}`); };
const count = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => count(n) && n > 0;
const finite = n => Number.isFinite(n) && n >= 0;
const tags = new Set(['#document', 'html', 'head', 'body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'ul', 'ol', 'li', 'blockquote', 'span', 'strong', 'em', 's', 'u', 'a', 'br', '#text']);
const family = tag => tag === 'p' ? 'paragraph' : /^h[1-6]$/.test(tag) ? 'heading' : tag === 'pre' ? 'code' : tag === 'li' ? 'list-item' : tag === 'ul' || tag === 'ol' ? 'list' : tag === 'blockquote' ? 'quote' : 'other';
export function layoutEventData(args) {
  const begin = args?.beginData, roots = args?.endData?.layoutRoots;
  check(begin && Array.isArray(roots) && roots.length > 0 && roots.length <= 4096, 'missing/overflow layout roots');
  check(count(begin.dirtyObjects) && count(begin.totalObjects) && begin.dirtyObjects <= begin.totalObjects && typeof begin.partialLayout === 'boolean', 'layout counters');
  check(roots.every(r => positive(r.nodeId)), 'backend identity');
  return { dirtyObjects: begin.dirtyObjects, totalObjects: begin.totalObjects, partialLayout: begin.partialLayout, backendNodeIds: [...new Set(roots.map(r => r.nodeId))] };
}
export function resolveLayoutRoots(document, layouts, windowMs) {
  check(Array.isArray(layouts) && layouts.length > 0 && layouts.length <= 4096 && finite(windowMs) && windowMs > 0, 'window/events');
  const nodes = new Map(); let size = 0, editor;
  const visit = (node, parent, insideEditor) => {
    check(++size <= 100000 && positive(node.backendNodeId) && !nodes.has(node.backendNodeId), 'DOM overflow/identity');
    const attrs = node.attributes ?? [], tag = String(node.nodeName).toLowerCase();
    const isEditor = attrs.some((v, i) => i % 2 === 0 && v === 'id' && attrs[i + 1] === 'editor');
    const entry = { backendNodeId: node.backendNodeId, parent, tag: tags.has(tag) ? tag : 'other', family: family(tag), insideEditor: insideEditor || isEditor, families: {} };
    nodes.set(node.backendNodeId, entry);
    if (isEditor) { check(!editor, 'duplicate editor'); editor = entry; }
    // Count semantic content elements once, including nested list items separately.
    if (entry.insideEditor && entry.family !== 'other') entry.families[entry.family] = 1;
    for (const child of node.children ?? []) {
      const nested = visit(child, entry.backendNodeId, entry.insideEditor);
      for (const [key, value] of Object.entries(nested.families)) entry.families[key] = (entry.families[key] ?? 0) + value;
    }
    return entry;
  };
  visit(document, null, false); check(editor, 'missing editor');
  const ids = new Set(); let previous = 0;
  for (const event of layouts) {
    check(finite(event.startMs) && event.startMs >= previous && event.startMs < windowMs && finite(event.durationMs) && event.durationMs <= windowMs - event.startMs + 1, 'event clock'); previous = event.startMs;
    check(count(event.dirtyObjects) && count(event.totalObjects) && event.dirtyObjects <= event.totalObjects && typeof event.partialLayout === 'boolean', 'event counters');
    check(Array.isArray(event.backendNodeIds) && event.backendNodeIds.length > 0 && event.backendNodeIds.every(positive), 'event identity');
    for (const id of event.backendNodeIds) { check(nodes.has(id), 'unresolved backend node'); ids.add(id); }
  }
  const roots = [...ids].sort((a, b) => a - b).map(id => {
    const node = nodes.get(id), ancestors = []; let cursor = node;
    while (cursor) { ancestors.push({ backendNodeId: cursor.backendNodeId, tag: cursor.tag }); cursor = nodes.get(cursor.parent); }
    return { backendNodeId: id, tag: node.tag, family: node.family, insideEditor: node.insideEditor,
      containsEditor: ancestors.length > 0 && (() => { let c = editor; while (c) { if (c === node) return true; c = nodes.get(c.parent); } return false; })(),
      families: node.families, ancestors };
  });
  return { version: 'cdp-layout-roots-v1', scope: 'Main-thread layout root/subtree scope; inclusive event costs cannot be allocated to descendant families. DOM resolved after timed work; no performance improvement or screen-reader claim.', windowMs, domNodes: size, editorFamilies: editor.families, layouts, roots };
}
export async function captureLayoutRoots(cdp, layouts, windowMs) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
  return resolveLayoutRoots(root, layouts, windowMs);
}
