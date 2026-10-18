import { Extension } from '@edit-ac/web';
import { ExtensionCommandSession } from '@edit-ac/web/modules';

export const kickoffSource = '> [!NOTE]\n> # Project kickoff\n> Owner: Alex\n> Due Friday\n';
const feature = id => ({ id, version: 1, schemas: ['editac.registry.editor.v5'], capabilities: ['commands', 'source-fallback'], permissions: [], requires: [], conflicts: [], bindings: [], qualification: 'qualified', owner: 'structural-callout-recipe', ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude', selection: 'prepared-result', history: 'one-intent', presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' } });
export const highlightDefinition = Object.freeze({ type: 'demo.highlight', version: 1, kind: 'mark', attributes: { label: { type: 'string', required: true, maxUtf16: 128 } }, content: { type: 'text', maxUtf16: 128 }, fallback: { type: 'text', source: 'content' } });

/** A real existing engine content block, not heading/bold or a DOM-only wrapper. */
export function prepareCallout(codec, source = kickoffSource) {
  if (typeof source !== 'string' || source.length > 8192) throw Error('Bounded callout Markdown required');
  const parsed = codec.importMarkdown(source, { callouts: true });
  const block = parsed.blocks[0], tuple = block?.attributes?.tuple;
  if (parsed.blocks.length !== 1 || block.attributes.type !== 'content' || tuple?.[0] !== 'module:editac.callout' || tuple[1] !== 1) throw Error('One admitted NOTE/TIP/IMPORTANT/WARNING/CAUTION callout required');
  return parsed;
}
export function createKickoffExtensions(codec, { onAttach } = {}) {
  const Callout = Extension.create({ apiVersion: 1, feature: feature('demo.kickoff'), semantics: { kind: 'behavior' }, defaults: {}, validateOptions: () => true, loading: 'required-input', interests: [], onAttach,
    commands: {
      callout(source, context) { const blocks = prepareCallout(codec, source ?? kickoffSource).blocks; const target = context.captureTarget(); if (!target) return; return { kind: 'fragment', origin: 'local:kickoff-callout', range: target.range, blocks }; },
      emphasize(_, context) { const target = context.captureTarget(); if (!target) return; return { kind: 'format', origin: 'local:kickoff-emphasis', marks: [{ range: target.range, mark: 'bold', action: 'apply' }], blocks: [] }; },
    } });
  const Highlight = Extension.create({ apiVersion: 1, feature: { ...feature('demo.highlight'), definition: highlightDefinition }, semantics: { kind: 'data', definition: highlightDefinition }, defaults: {}, validateOptions: () => true, loading: 'required-input', interests: [],
    commands: { highlight(text, context) { if (typeof text !== 'string' || !text || text.length > 128) return; const target = context.captureTarget(); if (!target) return; return { kind: 'fragment', origin: 'local:kickoff-highlight', range: target.range, blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text, marks: [], attributes: { 'module:demo.highlight': [1, { label: 'Review due date' }] } }] }] }; } } });
  return [Callout.configure(), Highlight.configure()];
}
const descriptor = node => { const tuple = node.blockAttributes; return Array.isArray(tuple) && tuple[0] === 'module:editac.callout' && tuple[1] === 1 ? tuple[2] : undefined; };
const releaseResult = (engine, result) => { if (result?.caret) engine.releaseAnchor(result.caret); if (result?.selection) { engine.releaseAnchor(result.selection.anchor); engine.releaseAnchor(result.selection.focus); } };

/** Existing ContentFactory port. Body editing replaces one admitted source block.
 * Body Markdown is retained data, not a second nested editable document. */
export function calloutPresenter(codec, stats = {}) {
  stats.mounted ??= 0; stats.disposed ??= 0; stats.listeners ??= 0;
  return context => {
    let node = context.node, data = descriptor(node); if (!data) return;
    const doc = context.element.ownerDocument, element = doc.createElement('aside'), label = doc.createElement('strong'), body = doc.createElement('pre'), input = doc.createElement('textarea'), apply = doc.createElement('button'), status = doc.createElement('output');
    element.dataset.contentModule = 'kickoff-callout'; element.contentEditable = 'false'; element.setAttribute('aria-label', 'Project kickoff callout'); input.setAttribute('aria-label', 'Callout Markdown source'); apply.type = 'button'; apply.textContent = 'Apply callout source'; element.append(label, body, input, apply, status);
    let disposed = false, readOnly = context.readOnly, expected = JSON.stringify(node.blockAttributes);
    const paint = () => { label.textContent = data.kind; body.textContent = data.body; input.value = data.source; input.readOnly = readOnly; apply.disabled = readOnly; };
    const commands = new ExtensionCommandSession({ get active() { return !disposed; }, revision() { const s = context.engine.read(); return JSON.stringify([s.identity, s.revision]); }, can: request => !readOnly && context.engine.can(request), commit: request => context.commit(request) });
    const edit = async () => {
      if (disposed || readOnly) return;
      let a;
      try {
        const current = context.engine.read().visible.find(n => n.id === node.id);
        if (!current || JSON.stringify(current.blockAttributes) !== expected) throw Error('Callout changed; reopen source before editing');
        const blocks = prepareCallout(codec, input.value).blocks;
        a = context.engine.anchor(node.id, 0, 'right');
        const result = await commands.run(() => ({ kind: 'editor', origin: 'local:kickoff-source', commands: [{ type: 'atomicContent', owner: node.id, expected: current.blockAttributes, at: a, replacement: blocks[0].attributes.tuple }] }));
        if (result.status === 'committed') releaseResult(context.engine, result.result);
        if (!disposed) status.textContent = result.status;
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { if (a) context.engine.releaseAnchor(a); }
    };
    const stop = event => event.stopPropagation();
    const events = ['keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'copy', 'cut', 'paste', 'pointerdown', 'pointerup'];
    for (const event of events) element.addEventListener(event, stop);
    apply.addEventListener('click', edit); stats.mounted++; stats.listeners += events.length + 1; paint();
    return { element, update(next) { const nextData = descriptor(next); if (disposed || !nextData) return false; node = next; data = nextData; expected = JSON.stringify(node.blockAttributes); paint(); return true; }, setReadOnly(value) { readOnly = value; paint(); }, dispose() { if (disposed) return; disposed = true; commands.dispose(); for (const event of events) element.removeEventListener(event, stop); apply.removeEventListener('click', edit); stats.disposed++; stats.listeners -= events.length + 1; } };
  };
}

/** Capture before a button takes DOM focus; dispose releases the stable target. */
export function bindEmphasisMenu(editor, button, stats = {}) {
  let command, disposed = false; stats.menuListeners ??= 0;
  const release = () => { command?.dispose(); command = undefined; };
  const capture = event => { event.preventDefault(); release(); command = editor.captureCommand('bold'); };
  const execute = () => { if (disposed) return; try { command?.execute(); } finally { release(); } };
  button.addEventListener('pointerdown', capture); button.addEventListener('click', execute); stats.menuListeners += 2;
  return () => { if (disposed) return; disposed = true; release(); button.removeEventListener('pointerdown', capture); button.removeEventListener('click', execute); stats.menuListeners -= 2; };
}
