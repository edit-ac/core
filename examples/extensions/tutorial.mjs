import { ModuleRegistry } from '@edit-ac/core/extensions';
import { createEditor, taskPreset } from '@edit-ac/web';
import { ExtensionCommandSession, prepareExtensionSource } from '@edit-ac/web/modules';

// Descriptor data is deliberately separate from executable host callbacks.
export function registerTutorial(definitions, { presenters = false, enabled = true } = {}) {
  const registry = new ModuleRegistry();
  if (enabled) for (const descriptor of definitions) registry.register(descriptor,
    presenters ? { tag: descriptor.kind === 'mark' ? 'mark' : 'span' } : undefined);
  return registry.freeze();
}

// This syntax uses existing heading/bold semantics. It does not invent a command
// that creates arbitrary module attributes or perform a live schema migration.
export const noteCodec = Object.freeze({
  name: 'tutorial-note',
  prepare(parsed) {
    if (!parsed.source.startsWith('[note] ')) return undefined;
    return [{ attributes: { type: 'heading', level: 2 },
      runs: [{ text: parsed.source.slice(7), marks: [{ mark: 'bold' }] }],
      containers: [], checked: null }];
  },
  serialize(blocks) {
    if (blocks.length !== 1 || blocks[0].attributes.type !== 'heading' || blocks[0].attributes.level !== 2) return undefined;
    return '[note] ' + blocks[0].runs.map(run => run.text).join('');
  },
});
export const prepareNote = (codec, source, literal = false) =>
  prepareExtensionSource(codec, source, { extensions: [noteCodec] }, literal);

// The plain source is readable, but not a lossless custom-attribute encoding.
// Keep the original checkpoint rather than passing flattened data off as a copy.
export function exportFallback(engine) {
  return { source: engine.read().visible.filter(n => n.kind === 'block')
      .map(n => n.runs.map(run => run.text).join('')).join('\n'),
    diagnostics: [{ code: 'module-markdown-unrepresentable' }], recovery: engine.checkpoint() };
}

export async function openTutorial(root, options) {
  const { definitions, presenters = false, enabled = true, stats = {}, ...hostOptions } = options;
  for (const name of ['mounted', 'disposed', 'observed']) stats[name] ??= 0;
  const renderer = { mount(element, content) {
    stats.mounted++;
    const paint = value => { element.textContent = value.attributes.label ?? value.text;
      element.setAttribute('aria-label', value.attributes.label ?? value.text); };
    paint(content);
    let live = true;
    return { update: paint, dispose() { if (live) { live = false; stats.disposed++; element.replaceChildren(); } } };
  } };
  const registry = registerTutorial(definitions, { presenters, enabled });
  const editor = createEditor(root, { ...taskPreset({ plainPasteControl: false }), ...hostOptions,
    modules: registry, moduleRuntime: { renderers: presenters && enabled
      ? Object.fromEntries(definitions.map(d => [d.type, renderer])) : {} } });
  try { await editor.ready; } catch (error) { await editor.destroy({ policy: 'report' }); throw error; }
  const commands = new ExtensionCommandSession({
    get active() { return editor.state.ready; },
    revision() { const snapshot = editor.read(); return JSON.stringify([snapshot.identity, snapshot.revision]); },
    can: request => editor.can(request), commit: request => editor.commit(request),
  });
  const subscription = editor.moduleRuntime.subscribe({}, () => stats.observed++);
  let closing;
  return { editor, commands, registry, subscription, stats,
    // Use the same atomic, capability-checked fragment boundary as paste.
    async insertNote(codec, owner, source, literal = false) {
      const parsed = prepareNote(codec, source, literal);
      const node = editor.read().visible.find(n => n.id === owner);
      if (!node) throw Error('Missing target');
      const anchor = editor.anchor(owner, 0, 'right');
      const focus = editor.anchor(owner, node.runs.reduce((n, run) => n + run.text.length, 0), 'left');
      try {
        const result = await commands.run(() => ({ kind: 'fragment', origin: 'local:tutorial', range: { anchor, focus }, blocks: parsed.blocks }));
        if (result.status === 'committed') {
          if (result.result.caret) editor.releaseAnchor(result.result.caret);
          if (result.result.selection) { editor.releaseAnchor(result.result.selection.anchor); editor.releaseAnchor(result.result.selection.focus); }
        }
        return result;
      } finally { editor.releaseAnchor(anchor); editor.releaseAnchor(focus); }
    },
    dispose() {
      if (!closing) { commands.dispose(); subscription.dispose(); closing = editor.destroy({ policy: 'flush' }); }
      return closing;
    },
  };
}
